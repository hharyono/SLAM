#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

namespace {
using Clock = std::chrono::steady_clock;
volatile std::sig_atomic_t stopping = 0;
void Stop(int) { stopping = 1; }
constexpr std::size_t kCapacity = 8192;
constexpr auto kStall = std::chrono::seconds(2);

struct Fd {
  int value = -1;
  explicit Fd(int v = -1) : value(v) {}
  ~Fd() { Reset(); }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  void Reset(int v = -1) { if (value >= 0) ::close(value); value = v; }
};
struct Queue {
  std::array<std::uint8_t, kCapacity> bytes{};
  std::size_t offset = 0, size = 0;
  Clock::time_point progress{};
  void Clear() { offset = size = 0; }
  bool Append(const std::uint8_t* data, std::size_t count) {
    if (count > kCapacity - size) return false;
    if (!size) progress = Clock::now();
    if (offset + size + count > kCapacity) {
      std::memmove(bytes.data(), bytes.data() + offset, size); offset = 0;
    }
    std::memcpy(bytes.data() + offset + size, data, count); size += count;
    return true;
  }
  void Consume(std::size_t count) {
    offset += count; size -= count; progress = Clock::now();
    if (!size) offset = 0;
  }
  bool Stalled() const { return size && Clock::now() - progress >= kStall; }
};
bool MoveMavlinkFrame(Queue& from, Queue& to) {
  while (from.size && from.bytes[from.offset] != 0xfe && from.bytes[from.offset] != 0xfd)
    from.Consume(1);
  if (from.size < 2) return false;
  const auto* p=from.bytes.data()+from.offset;
  if (p[0]==0xfd && from.size<3) return false;
  const std::size_t total=p[0]==0xfe?static_cast<std::size_t>(p[1])+8:
      static_cast<std::size_t>(p[1])+12+((p[2]&1)?13:0);
  if(from.size<total||kCapacity-to.size<total)return false;
  to.Append(p,total);from.Consume(total);return true;
}
struct Config {
  std::string serial = "/dev/ttyS5", bind = "0.0.0.0";
  unsigned baud = 115200, port = 5760, upload_port = 5761;
};
unsigned Number(const std::string& value) {
  if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos)
    throw std::runtime_error("expected an unsigned integer: " + value);
  const auto n = std::stoul(value);
  if (n > 1000000) throw std::runtime_error("number out of range: " + value);
  return static_cast<unsigned>(n);
}
speed_t Baud(unsigned n) {
  switch (n) {
    case 57600: return B57600;
    case 115200: return B115200;
    case 230400: return B230400;
    case 460800: return B460800;
    case 921600: return B921600;
    default: throw std::runtime_error("unsupported baud rate");
  }
}
void Fail(const std::string& op) {
  throw std::runtime_error(op + ": " + std::strerror(errno));
}
int OpenSerial(const Config& c) {
  const int fd = ::open(c.serial.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) Fail("open " + c.serial);
  try {
    if (::flock(fd, LOCK_EX | LOCK_NB) < 0) Fail("lock " + c.serial);
    termios tty{};
    if (::tcgetattr(fd, &tty) < 0) Fail("tcgetattr");
    ::cfmakeraw(&tty);
    tty.c_cflag &= ~(CSIZE | PARENB | CSTOPB | CRTSCTS);
    tty.c_cflag |= CS8 | CREAD | CLOCAL;
    tty.c_cc[VMIN] = 1; tty.c_cc[VTIME] = 0;
    if (::cfsetispeed(&tty, Baud(c.baud)) < 0 || ::cfsetospeed(&tty, Baud(c.baud)) < 0 ||
        ::tcsetattr(fd, TCSANOW, &tty) < 0 || ::tcflush(fd, TCIOFLUSH) < 0)
      Fail("configure " + c.serial);
    return fd;
  } catch (...) { ::close(fd); throw; }
}
int Listen(const Config& c, unsigned port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) Fail("socket");
  try {
    int one = 1;
    if (::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) Fail("SO_REUSEADDR");
    sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_port = htons(port);
    if (::inet_pton(AF_INET, c.bind.c_str(), &addr.sin_addr) != 1)
      throw std::runtime_error("--bind must be a numeric IPv4 address");
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) Fail("bind");
    if (::listen(fd, 4) < 0) Fail("listen");
    return fd;
  } catch (...) { ::close(fd); throw; }
}
bool Retryable() { return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR; }

int Run(const Config& cfg) {
  Fd listener(Listen(cfg, cfg.port)), upload_listener(Listen(cfg, cfg.upload_port));
  Fd serial, gcs, upload;
  Queue to_serial, from_gcs, from_upload, to_gcs, to_upload;
  bool upload_turn=false;
  std::uint64_t serial_bytes = 0, tcp_bytes = 0;
  auto serial_retry = Clock::now();
  auto serial_log = Clock::time_point{};
  auto stats_time = Clock::now();
  auto last_socket_tx = Clock::now();
  auto last_serial_tx = Clock::now();
  std::cerr << "listening=" << cfg.bind << ':' << cfg.port
            << " upload=" << cfg.bind << ':' << cfg.upload_port << " serial=" << cfg.serial
            << " baud=" << cfg.baud << " mode=dual_client upload_tx_priority=1\n";
  auto DisconnectGcs = [&](const char* reason) {
    if (gcs.value >= 0) std::cerr << "gcs_disconnected=" << reason << '\n';
    gcs.Reset(); to_gcs.Clear(); from_gcs.Clear();
  };
  auto DisconnectUpload = [&](const char* reason) {
    if (upload.value >= 0) std::cerr << "upload_disconnected=" << reason << '\n';
    upload.Reset(); to_upload.Clear(); from_upload.Clear();
  };
  auto SerialLost = [&]() {
    DisconnectGcs("serial_unavailable"); DisconnectUpload("serial_unavailable"); serial.Reset();
    serial_retry = Clock::now() + std::chrono::seconds(1);
    std::cerr << "serial_disconnected=" << cfg.serial << '\n';
  };
  std::array<std::uint8_t, 4096> buf{};
  while (!stopping) {
    if (serial.value < 0 && Clock::now() >= serial_retry) {
      try {
        serial.Reset(OpenSerial(cfg));
        std::cerr << "serial_connected=" << cfg.serial << '\n';
      } catch (const std::exception& e) {
        if (serial_log == Clock::time_point{} || Clock::now() - serial_log >= std::chrono::seconds(10)) {
          std::cerr << "serial_retry=" << e.what() << '\n'; serial_log = Clock::now();
        }
        serial_retry = Clock::now() + std::chrono::seconds(1);
      }
    }
    pollfd p[5] = {
      {listener.value, POLLIN, 0},
      {upload_listener.value, POLLIN, 0},
      {serial.value, static_cast<short>(POLLIN | (to_serial.size ? POLLOUT : 0)), 0},
      {gcs.value, static_cast<short>((from_gcs.size < kCapacity ? POLLIN : 0) |
                                    (to_gcs.size ? POLLOUT : 0)), 0},
      {upload.value, static_cast<short>((from_upload.size < kCapacity ? POLLIN : 0) |
                                       (to_upload.size ? POLLOUT : 0)), 0}
    };
    const int ready = ::poll(p, 5, 100);
    if (ready < 0) { if (errno == EINTR) continue; Fail("poll"); }
    if (p[0].revents & (POLLERR | POLLHUP | POLLNVAL))
      throw std::runtime_error("TCP listener failed");
    if (p[1].revents & (POLLERR | POLLHUP | POLLNVAL))
      throw std::runtime_error("upload TCP listener failed");
    // Handle failures before data; a closed session never leaves commands queued.
    if (serial.value >= 0 && (p[2].revents & (POLLERR | POLLHUP | POLLNVAL))) SerialLost();
    if (gcs.value >= 0 && (p[3].revents & (POLLERR | POLLHUP | POLLNVAL))) DisconnectGcs("tcp_closed");
    if (upload.value >= 0 && (p[4].revents & (POLLERR | POLLHUP | POLLNVAL))) DisconnectUpload("tcp_closed");
    if (gcs.value >= 0 && (p[3].revents & POLLIN)) {
      const auto n = ::recv(gcs.value, buf.data(), std::min(buf.size(), kCapacity-from_gcs.size), 0);
      if (n > 0) { from_gcs.Append(buf.data(), n); tcp_bytes += n; }
      else if (n == 0 || !Retryable()) DisconnectGcs("tcp_closed");
    }
    if (upload.value >= 0 && (p[4].revents & POLLIN)) {
      const auto n = ::recv(upload.value,buf.data(),std::min(buf.size(),kCapacity-from_upload.size),0);
      if (n > 0) { from_upload.Append(buf.data(),n); tcp_bytes += n; }
      else if (n == 0 || !Retryable()) DisconnectUpload("tcp_closed");
    }
    if (serial.value >= 0 && (p[2].revents & POLLIN)) {
      const auto n = ::read(serial.value, buf.data(), buf.size());
      if (n > 0) {
        serial_bytes += n;
        // Drain telemetry even with no GCS: a new session starts with live data.
        if (gcs.value >= 0 && !to_gcs.Append(buf.data(),n)) DisconnectGcs("tcp_queue_full");
        if (upload.value >= 0 && !to_upload.Append(buf.data(),n)) DisconnectUpload("tcp_queue_full");
      } else if (n == 0 || !Retryable()) SerialLost();
    }
    if(!to_serial.size){
      bool moved=upload_turn?MoveMavlinkFrame(from_upload,to_serial):MoveMavlinkFrame(from_gcs,to_serial);
      if(!moved)moved=upload_turn?MoveMavlinkFrame(from_gcs,to_serial):MoveMavlinkFrame(from_upload,to_serial);
      if(moved)upload_turn=!upload_turn;
    }
    if (serial.value >= 0 && to_serial.size && (p[2].revents & POLLOUT)) {
      const auto n = ::write(serial.value, to_serial.bytes.data()+to_serial.offset, to_serial.size);
      if (n > 0) { to_serial.Consume(n); last_serial_tx = Clock::now(); }
      else if (n < 0 && !Retryable()) SerialLost();
    }
    if (gcs.value >= 0 && to_gcs.size && (p[3].revents & POLLOUT)) {
      const auto n=::send(gcs.value,to_gcs.bytes.data()+to_gcs.offset,to_gcs.size,MSG_NOSIGNAL);
      if(n>0){to_gcs.Consume(n);last_socket_tx=Clock::now();}
      else if(n<0&&!Retryable())DisconnectGcs("tcp_write_failed");
    }
    if (upload.value >= 0 && to_upload.size && (p[4].revents & POLLOUT)) {
      const auto n=::send(upload.value,to_upload.bytes.data()+to_upload.offset,to_upload.size,MSG_NOSIGNAL);
      if(n>0){to_upload.Consume(n);last_socket_tx=Clock::now();}
      else if(n<0&&!Retryable())DisconnectUpload("tcp_write_failed");
    }
    if (to_serial.Stalled()) { if(upload.value>=0)DisconnectUpload("forwarding_stalled");else DisconnectGcs("forwarding_stalled"); }
    if (to_gcs.Stalled()) DisconnectGcs("forwarding_stalled");
    if (to_upload.Stalled()) DisconnectUpload("forwarding_stalled");
    // Port 5760 monitoring remains connected while port 5761 has serial TX priority.
    for (int listener_index = 1; listener_index >= 0; --listener_index) {
      if (!(p[listener_index].revents & POLLIN)) continue;
      sockaddr_in addr{}; socklen_t len = sizeof(addr);
      const bool uploading = listener_index == 1;
      const int fd = ::accept4(p[listener_index].fd, reinterpret_cast<sockaddr*>(&addr), &len,
                               SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (fd >= 0) {
        Fd& target=uploading?upload:gcs;
        if (serial.value < 0 || target.value >= 0) {
          ::close(fd);
          std::cerr << "client_rejected=" << (serial.value < 0 ? "serial_unavailable" : "busy") << '\n';
        } else {
          int one=1, sendbuf=32768, idle=10, interval=3, count=3;
          const bool ok = ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) == 0 &&
              ::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one)) == 0 &&
              ::setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sendbuf, sizeof(sendbuf)) == 0 &&
              ::setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle)) == 0 &&
              ::setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof(interval)) == 0 &&
              ::setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count)) == 0;
          if (!ok) { ::close(fd); std::cerr << "client_rejected=socket_configuration\n"; }
          else {
            if(uploading){from_upload.Clear();to_upload.Clear();}
            else to_gcs.Clear();
            target.Reset(fd);
            last_socket_tx = last_serial_tx = Clock::now();
            char ip[INET_ADDRSTRLEN]{};
            ::inet_ntop(AF_INET, &addr.sin_addr, ip, sizeof(ip));
            std::cerr << "client_connected=" << ip << ':' << ntohs(addr.sin_port)
                      << " role=" << (uploading ? "upload_or_landing" : "gcs") << '\n';
          }
        }
      } else if (!Retryable()) Fail("accept");
    }
    if (Clock::now()-stats_time >= std::chrono::seconds(10)) {
      std::cerr << "serial_rx_bytes=" << serial_bytes << " tcp_rx_bytes=" << tcp_bytes
                << " gcs=" << (gcs.value >= 0) << " upload=" << (upload.value >= 0)
                << " serial=" << (serial.value >= 0) << '\n';
      stats_time = Clock::now();
    }
  }
  DisconnectGcs("shutdown"); DisconnectUpload("shutdown");
  std::cerr << "bridge_stopped\n";
  return 0;
}
} // namespace

int main(int argc, char** argv) try {
  Config cfg;
  for (int i=1; i<argc; ++i) {
    const std::string key=argv[i];
    if (key=="--help") {
      std::cout << "Usage: mavlink_bridge [--serial /dev/ttyS5] [--baud 115200]\n"
                   "                      [--bind 0.0.0.0] [--port 5760] [--upload-port 5761]\n";
      return 0;
    }
    if (++i==argc) throw std::runtime_error("missing value for " + key);
    if (key=="--serial") cfg.serial=argv[i];
    else if (key=="--baud") cfg.baud=Number(argv[i]);
    else if (key=="--bind") cfg.bind=argv[i];
    else if (key=="--port") cfg.port=Number(argv[i]);
    else if (key=="--upload-port") cfg.upload_port=Number(argv[i]);
    else throw std::runtime_error("unknown option " + key);
  }
  if (cfg.serial.empty() || cfg.port<1 || cfg.port>65535 || cfg.upload_port<1 ||
      cfg.upload_port>65535 || cfg.upload_port==cfg.port)
    throw std::runtime_error("invalid serial path or TCP port");
  Baud(cfg.baud);
  struct sigaction sa{}; sa.sa_handler=Stop; ::sigemptyset(&sa.sa_mask);
  ::sigaction(SIGINT, &sa, nullptr); ::sigaction(SIGTERM, &sa, nullptr);
  return Run(cfg);
} catch (const std::exception& e) {
  std::cerr << "mavlink_bridge: " << e.what() << '\n'; return 1;
}
