#include "luckfox/scan_tcp_client.hpp"

#include <arpa/inet.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace luckfox {
namespace {
constexpr std::uint32_t kMagic = 0x53434e31;  // SCN1
constexpr std::uint32_t kMetadataBytes = 40;

void Put16(std::vector<std::uint8_t>& out, std::uint16_t value) {
  value = htons(value); const auto* p = reinterpret_cast<const std::uint8_t*>(&value);
  out.insert(out.end(), p, p + 2);
}
void Put32(std::vector<std::uint8_t>& out, std::uint32_t value) {
  value = htonl(value); const auto* p = reinterpret_cast<const std::uint8_t*>(&value);
  out.insert(out.end(), p, p + 4);
}
void Put64(std::vector<std::uint8_t>& out, std::uint64_t value) {
  Put32(out, static_cast<std::uint32_t>(value >> 32)); Put32(out, static_cast<std::uint32_t>(value));
}
void PutFloat(std::vector<std::uint8_t>& out, float value) {
  std::uint32_t bits; std::memcpy(&bits, &value, sizeof(bits)); Put32(out, bits);
}
bool SendAll(int fd, const std::vector<std::uint8_t>& data) {
  std::size_t offset = 0;
  while (offset < data.size()) {
    const auto sent = send(fd, data.data() + offset, data.size() - offset, MSG_NOSIGNAL);
    if (sent <= 0) return false;
    offset += static_cast<std::size_t>(sent);
  }
  return true;
}
}  // namespace

struct ScanTcpClient::Impl {
  explicit Impl(ScanTcpConfig value) : config(std::move(value)) {}
  ScanTcpConfig config; int fd = -1; std::thread worker; std::mutex mutex;
  CapturedScan scan; std::uint32_t input_sequence = 0, sent_sequence = 0;
  std::atomic<bool> running{false};
};

ScanTcpClient::ScanTcpClient(ScanTcpConfig config) : impl_(new Impl(std::move(config))) {}
ScanTcpClient::~ScanTcpClient() { Stop(); }

void ScanTcpClient::Start() {
  if (impl_->running.exchange(true)) return;
  impl_->worker = std::thread([this] {
    while (impl_->running) {
      CapturedScan scan; std::uint32_t sequence;
      { std::lock_guard<std::mutex> lock(impl_->mutex); scan = impl_->scan; sequence = impl_->input_sequence; }
      if (sequence == impl_->sent_sequence || scan.samples.empty()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue;
      }
      if (impl_->fd < 0) {
        impl_->fd = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(impl_->config.port);
        if (impl_->fd < 0 || inet_pton(AF_INET, impl_->config.host.c_str(), &address.sin_addr) != 1 ||
            connect(impl_->fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
          if (impl_->fd >= 0) close(impl_->fd);
          impl_->fd = -1;
          std::this_thread::sleep_for(std::chrono::seconds(1)); continue;
        }
        int enabled = 1; setsockopt(impl_->fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
      }
      const auto count = static_cast<std::uint32_t>(scan.samples.size());
      const auto payload_size = kMetadataBytes + count * 12;
      std::vector<std::uint8_t> frame; frame.reserve(16 + payload_size);
      Put32(frame, kMagic); Put16(frame, 1); Put16(frame, 1); Put32(frame, payload_size); Put32(frame, sequence);
      Put64(frame, scan.stamp_ns); PutFloat(frame, scan.angle_min); PutFloat(frame, scan.angle_max);
      PutFloat(frame, scan.angle_increment); PutFloat(frame, scan.time_increment); PutFloat(frame, scan.scan_time);
      PutFloat(frame, scan.range_min); PutFloat(frame, scan.range_max); Put32(frame, count);
      for (const auto& point : scan.samples) {
        PutFloat(frame, point.angle); PutFloat(frame, point.range); PutFloat(frame, point.intensity);
      }
      if (!SendAll(impl_->fd, frame)) { close(impl_->fd); impl_->fd = -1; continue; }
      impl_->sent_sequence = sequence;
    }
  });
}

void ScanTcpClient::Stop() noexcept {
  if (!impl_ || !impl_->running.exchange(false)) return;
  if (impl_->fd >= 0) shutdown(impl_->fd, SHUT_RDWR);
  if (impl_->worker.joinable()) impl_->worker.join();
  if (impl_->fd >= 0) close(impl_->fd);
  impl_->fd = -1;
}
void ScanTcpClient::UpdateScan(const CapturedScan& scan) {
  std::lock_guard<std::mutex> lock(impl_->mutex); impl_->scan = scan; ++impl_->input_sequence;
}
}  // namespace luckfox
