#include "luckfox/mavlink_output.hpp"

#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>
#include <fcntl.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

namespace luckfox {
namespace {
void Validate(const MavlinkConfig& c) {
  if (c.system_id < 1 || c.system_id > 255 || c.component_id < 1 ||
      c.component_id > 255 || !std::isfinite(c.map_heading_rad) ||
      !std::isfinite(c.origin_x) || !std::isfinite(c.origin_y) ||
      c.max_age_us == 0)
    throw std::invalid_argument("invalid MAVLink IDs, map transform or maximum age");
}
void PutFloat(std::vector<std::uint8_t>& b, unsigned offset, float value) {
  static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559,
                "MAVLink requires IEEE754 float32");
  std::uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  for (unsigned i = 0; i < 4; ++i) b[offset + i] = (bits >> (8*i)) & 255;
}
void Accumulate(std::uint8_t byte, std::uint16_t& crc) {
  std::uint8_t tmp = byte ^ (crc & 255);
  tmp ^= tmp << 4;
  crc = (crc >> 8) ^ (std::uint16_t(tmp) << 8) ^
        (std::uint16_t(tmp) << 3) ^ (tmp >> 4);
}
speed_t Speed(unsigned baud) {
  switch (baud) {
    case 57600: return B57600;
    case 115200: return B115200;
    case 230400: return B230400;
    case 460800: return B460800;
    case 921600: return B921600;
    default: throw std::invalid_argument("unsupported MAVLink baud rate");
  }
}
void Error(const char* operation) {
  throw std::runtime_error(std::string("MAVLink ") + operation + ": " + std::strerror(errno));
}
} // namespace

std::vector<std::uint8_t> EncodeVisionPosition(
    const MavlinkConfig& c, const Pose2f& pose, std::uint64_t time,
    std::uint8_t sequence, std::uint8_t reset) {
  Validate(c);
  if (!std::isfinite(pose.x) || !std::isfinite(pose.y) || !std::isfinite(pose.yaw))
    throw std::invalid_argument("non-finite MAVLink pose");
  // Payload layout from common.xml message 102; CRC_EXTRA = 158.
  std::vector<std::uint8_t> b(10 + 117, 0);
  b[0] = 0xfd; b[4] = sequence;
  b[5] = c.system_id; b[6] = c.component_id; b[7] = 102;
  for (unsigned i = 0; i < 8; ++i) b[10+i] = (time >> (8*i)) & 255;
  const float x = pose.x - c.origin_x, y = pose.y - c.origin_y;
  const float cs = std::cos(c.map_heading_rad), sn = std::sin(c.map_heading_rad);
  const float north = cs*x + sn*y, east = sn*x - cs*y;
  if (!std::isfinite(north) || !std::isfinite(east))
    throw std::invalid_argument("MAVLink map transform overflow");
  PutFloat(b, 18, north);
  PutFloat(b, 22, east);
  // Z/roll/pitch are placeholders for this planar localizer, never fuse Z.
  PutFloat(b, 38, std::remainder(c.map_heading_rad - pose.yaw, 6.28318530718F));
  PutFloat(b, 42, std::numeric_limits<float>::quiet_NaN());
  b[126] = reset;
  // MAVLink 2 removes trailing zero payload bytes, including base fields.
  while (b.size() > 11 && b.back() == 0) b.pop_back();
  b[1] = b.size() - 10;
  std::uint16_t crc = 0xffff;
  for (std::size_t i = 1; i < b.size(); ++i) Accumulate(b[i], crc);
  Accumulate(158, crc);
  b.push_back(crc & 255); b.push_back(crc >> 8);
  return b;
}

MavlinkOutput::MavlinkOutput(MavlinkConfig config) : config_(std::move(config)) {
  Validate(config_);
  const auto speed = Speed(config_.baud);
  fd_ = ::open(config_.port.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (fd_ < 0) Error("open serial port");
  try {
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) Error("lock serial port");
    termios tty{};
    if (::tcgetattr(fd_, &tty) != 0) Error("get serial attributes");
    ::cfmakeraw(&tty);
    tty.c_cflag &= ~(PARENB | CSTOPB | CSIZE | CRTSCTS);
    tty.c_cflag |= CS8 | CLOCAL | CREAD;
    if (::cfsetispeed(&tty, speed) != 0 || ::cfsetospeed(&tty, speed) != 0 ||
        ::tcsetattr(fd_, TCSANOW, &tty) != 0) Error("configure serial port");
    if (::tcflush(fd_, TCIOFLUSH) != 0) Error("flush serial port");
  } catch (...) {
    ::close(fd_); fd_ = -1; throw;
  }
}
MavlinkOutput::~MavlinkOutput() { if (fd_ >= 0) ::close(fd_); }
void MavlinkOutput::Reset() noexcept { reset_pending_ = true; }

bool MavlinkOutput::Send(const LocalizationResult& r, std::uint64_t time,
                         std::uint64_t now) {
  if (r.global_search || r.state == LocalizationState::Recovered ||
      r.state == LocalizationState::Lost || r.state == LocalizationState::GlobalSearch)
    Reset();
  if (!r.valid || r.state != LocalizationState::Tracking || time == 0 ||
      time > now || now - time > config_.max_age_us || time <= last_timestamp_ ||
      !std::isfinite(r.pose.x) || !std::isfinite(r.pose.y) || !std::isfinite(r.pose.yaw))
    return false;
  int queued = 0;
  if (::ioctl(fd_, TIOCOUTQ, &queued) != 0) Error("query output queue");
  if (queued > 0) return false;
  if (reset_pending_) {
    if (sent_) ++reset_counter_;
    reset_pending_ = false;
  }
  const auto packet = EncodeVisionPosition(config_, r.pose, time, sequence_++, reset_counter_);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(20);
  std::size_t offset = 0;
  while (offset < packet.size()) {
    const int remaining = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
        deadline - std::chrono::steady_clock::now()).count());
    if (remaining <= 0) {
      ::tcflush(fd_, TCOFLUSH);
      throw std::runtime_error("MAVLink serial write timed out");
    }
    pollfd pfd{fd_, POLLOUT, 0};
    const int ready = ::poll(&pfd, 1, remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) Error("poll serial port");
    if (ready == 0) continue;
    if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL))
      throw std::runtime_error("MAVLink serial port disconnected");
    const auto written = ::write(fd_, packet.data()+offset, packet.size()-offset);
    if (written < 0 && (errno == EAGAIN || errno == EINTR)) continue;
    if (written < 0) Error("write serial port");
    offset += static_cast<std::size_t>(written);
  }
  last_timestamp_ = time;
  sent_ = true;
  return true;
}
} // namespace luckfox
