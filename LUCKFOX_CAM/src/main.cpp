#include <arpa/inet.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
std::atomic<bool> running{true};

struct Config {
  std::string device = "/dev/video0";
  std::string bind = "0.0.0.0";
  unsigned port = 8080;
  unsigned width = 640;
  unsigned height = 480;
  unsigned fps = 15;
};

struct FrameStore {
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<unsigned char> jpeg;
  uint64_t sequence = 0;
  std::atomic<bool> camera_connected{false};
  std::string error = "waiting for camera";
};

struct Buffer { void* data = MAP_FAILED; size_t size = 0; };

void SignalHandler(int) { running = false; }

void Xioctl(int fd, unsigned long request, void* arg) {
  int rc;
  do { rc = ioctl(fd, request, arg); } while (rc < 0 && errno == EINTR);
  if (rc < 0) throw std::runtime_error(std::string("ioctl: ") + std::strerror(errno));
}

bool SendAll(int fd, const void* data, size_t size) {
  const char* p = static_cast<const char*>(data);
  while (size && running) {
    const ssize_t n = send(fd, p, size, MSG_NOSIGNAL);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    p += n;
    size -= static_cast<size_t>(n);
  }
  return size == 0;
}

bool SendText(int fd, const std::string& text) { return SendAll(fd, text.data(), text.size()); }

void SetError(FrameStore& store, const std::string& message) {
  store.camera_connected = false;
  std::lock_guard<std::mutex> lock(store.mutex);
  store.error = message;
}

void CaptureOnce(const Config& cfg, FrameStore& store) {
  const int fd = open(cfg.device.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) throw std::runtime_error("open " + cfg.device + ": " + std::strerror(errno));
  std::vector<Buffer> buffers;
  try {
    v4l2_capability cap{};
    Xioctl(fd, VIDIOC_QUERYCAP, &cap);
    if (!(cap.capabilities & V4L2_CAP_VIDEO_CAPTURE) || !(cap.capabilities & V4L2_CAP_STREAMING))
      throw std::runtime_error("device does not support V4L2 streaming capture");

    v4l2_format format{};
    format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    format.fmt.pix.width = cfg.width;
    format.fmt.pix.height = cfg.height;
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
    format.fmt.pix.field = V4L2_FIELD_ANY;
    Xioctl(fd, VIDIOC_S_FMT, &format);
    if (format.fmt.pix.pixelformat != V4L2_PIX_FMT_MJPEG)
      throw std::runtime_error("camera does not support MJPEG at requested resolution");

    v4l2_streamparm parm{};
    parm.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    parm.parm.capture.timeperframe.numerator = 1;
    parm.parm.capture.timeperframe.denominator = cfg.fps;
    ioctl(fd, VIDIOC_S_PARM, &parm);

    v4l2_requestbuffers request{};
    request.count = 4;
    request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    request.memory = V4L2_MEMORY_MMAP;
    Xioctl(fd, VIDIOC_REQBUFS, &request);
    if (request.count < 2) throw std::runtime_error("camera returned too few buffers");
    buffers.resize(request.count);
    for (unsigned i = 0; i < request.count; ++i) {
      v4l2_buffer buffer{};
      buffer.type = request.type; buffer.memory = request.memory; buffer.index = i;
      Xioctl(fd, VIDIOC_QUERYBUF, &buffer);
      buffers[i].size = buffer.length;
      buffers[i].data = mmap(nullptr, buffer.length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, buffer.m.offset);
      if (buffers[i].data == MAP_FAILED) throw std::runtime_error(std::string("mmap: ") + std::strerror(errno));
      Xioctl(fd, VIDIOC_QBUF, &buffer);
    }
    v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    Xioctl(fd, VIDIOC_STREAMON, &type);
    store.camera_connected = true;
    { std::lock_guard<std::mutex> lock(store.mutex); store.error.clear(); }
    std::cerr << "camera_connected device=" << cfg.device << " width=" << format.fmt.pix.width
              << " height=" << format.fmt.pix.height << " fps=" << cfg.fps << '\n';

    while (running) {
      pollfd poll_fd{fd, POLLIN, 0};
      const int ready = poll(&poll_fd, 1, 1000);
      if (ready < 0 && errno == EINTR) continue;
      if (ready < 0) throw std::runtime_error(std::string("poll: ") + std::strerror(errno));
      if (!ready) continue;
      v4l2_buffer buffer{};
      buffer.type = type; buffer.memory = V4L2_MEMORY_MMAP;
      if (ioctl(fd, VIDIOC_DQBUF, &buffer) < 0) {
        if (errno == EAGAIN || errno == EINTR) continue;
        throw std::runtime_error(std::string("VIDIOC_DQBUF: ") + std::strerror(errno));
      }
      if (buffer.index >= buffers.size() || buffer.bytesused > buffers[buffer.index].size)
        throw std::runtime_error("invalid V4L2 buffer");
      {
        std::lock_guard<std::mutex> lock(store.mutex);
        const auto* begin = static_cast<unsigned char*>(buffers[buffer.index].data);
        store.jpeg.assign(begin, begin + buffer.bytesused);
        ++store.sequence;
      }
      store.changed.notify_all();
      Xioctl(fd, VIDIOC_QBUF, &buffer);
    }
    ioctl(fd, VIDIOC_STREAMOFF, &type);
  } catch (...) {
    for (auto& buffer : buffers) if (buffer.data != MAP_FAILED) munmap(buffer.data, buffer.size);
    close(fd);
    throw;
  }
  for (auto& buffer : buffers) if (buffer.data != MAP_FAILED) munmap(buffer.data, buffer.size);
  close(fd);
}

void CaptureLoop(const Config& cfg, FrameStore& store) {
  while (running) {
    try { CaptureOnce(cfg, store); }
    catch (const std::exception& e) {
      SetError(store, e.what());
      std::cerr << "camera_retry error=\"" << e.what() << "\"\n";
      for (int i = 0; i < 20 && running; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }
}

void HandleClient(int fd, FrameStore& store) {
  timeval timeout{5, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  char request[2048]{};
  const ssize_t n = recv(fd, request, sizeof(request) - 1, 0);
  if (n <= 0) { close(fd); return; }
  std::string line(request, static_cast<size_t>(n));
  const bool stream = line.rfind("GET /stream.mjpg ", 0) == 0;
  const bool health = line.rfind("GET /health ", 0) == 0;
  const bool snapshot = line.rfind("GET /snapshot.jpg ", 0) == 0;
  if (health) {
    std::string error;
    { std::lock_guard<std::mutex> lock(store.mutex); error = store.error; }
    const std::string body = store.camera_connected ? "ok\n" : "waiting: " + error + "\n";
    SendText(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " +
                     std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
  } else if (snapshot) {
    std::vector<unsigned char> jpeg;
    { std::lock_guard<std::mutex> lock(store.mutex); jpeg = store.jpeg; }
    if (jpeg.empty()) SendText(fd, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    else {
      SendText(fd, "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                       std::to_string(jpeg.size()) + "\r\nConnection: close\r\n\r\n");
      SendAll(fd, jpeg.data(), jpeg.size());
    }
  } else if (stream) {
    if (!SendText(fd, "HTTP/1.1 200 OK\r\nCache-Control: no-cache\r\nConnection: close\r\n"
                      "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n")) { close(fd); return; }
    uint64_t seen = 0;
    while (running) {
      std::vector<unsigned char> jpeg;
      {
        std::unique_lock<std::mutex> lock(store.mutex);
        store.changed.wait_for(lock, std::chrono::seconds(2), [&]{ return store.sequence != seen || !running; });
        if (!running) break;
        if (store.sequence == seen || store.jpeg.empty()) continue;
        seen = store.sequence; jpeg = store.jpeg;
      }
      const std::string header = "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                                 std::to_string(jpeg.size()) + "\r\n\r\n";
      if (!SendText(fd, header) || !SendAll(fd, jpeg.data(), jpeg.size()) || !SendText(fd, "\r\n")) break;
    }
  } else {
    const std::string body = "Luckfox Camera\nVLC URL: /stream.mjpg\nHealth: /health\nSnapshot: /snapshot.jpg\n";
    SendText(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " +
                     std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
  }
  close(fd);
}

unsigned Number(const std::string& value) {
  if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos)
    throw std::runtime_error("invalid number: " + value);
  const auto number = std::stoul(value);
  if (number > 65535) throw std::runtime_error("number out of range: " + value);
  return static_cast<unsigned>(number);
}
}  // namespace

int main(int argc, char** argv) try {
  Config cfg;
  for (int i = 1; i < argc; ++i) {
    const std::string key = argv[i];
    if (key == "--help") {
      std::cout << "Usage: luckfox_cam [--device /dev/video0] [--bind 0.0.0.0] [--port 8080]"
                   " [--width 640] [--height 480] [--fps 15]\n";
      return 0;
    }
    if (++i == argc) throw std::runtime_error("missing value for " + key);
    if (key == "--device") cfg.device = argv[i];
    else if (key == "--bind") cfg.bind = argv[i];
    else if (key == "--port") cfg.port = Number(argv[i]);
    else if (key == "--width") cfg.width = Number(argv[i]);
    else if (key == "--height") cfg.height = Number(argv[i]);
    else if (key == "--fps") cfg.fps = Number(argv[i]);
    else throw std::runtime_error("unknown option: " + key);
  }
  if (!cfg.port || !cfg.width || !cfg.height || !cfg.fps) throw std::runtime_error("numeric values must be nonzero");
  struct sigaction action{}; action.sa_handler = SignalHandler; sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, nullptr); sigaction(SIGTERM, &action, nullptr);
  signal(SIGPIPE, SIG_IGN);

  FrameStore store;
  std::thread capture(CaptureLoop, std::cref(cfg), std::ref(store));
  const int server = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (server < 0) throw std::runtime_error(std::string("socket: ") + std::strerror(errno));
  int yes = 1; setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(cfg.port);
  if (inet_pton(AF_INET, cfg.bind.c_str(), &address.sin_addr) != 1) throw std::runtime_error("invalid IPv4 bind address");
  if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0)
    throw std::runtime_error(std::string("bind: ") + std::strerror(errno));
  if (listen(server, 8) < 0) throw std::runtime_error(std::string("listen: ") + std::strerror(errno));
  std::cerr << "server_started http=" << cfg.bind << ':' << cfg.port << " stream=/stream.mjpg\n";
  while (running) {
    pollfd pfd{server, POLLIN, 0};
    const int ready = poll(&pfd, 1, 500);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) continue;
    const int client = accept4(server, nullptr, nullptr, SOCK_CLOEXEC);
    if (client >= 0) std::thread(HandleClient, client, std::ref(store)).detach();
  }
  close(server); store.changed.notify_all(); capture.join();
  return 0;
} catch (const std::exception& e) {
  running = false;
  std::cerr << "luckfox_cam: " << e.what() << '\n';
  return 1;
}

