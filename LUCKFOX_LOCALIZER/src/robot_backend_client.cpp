#include "luckfox/robot_backend_client.hpp"

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
constexpr std::uint32_t kMagic = 0x41475631;  // AGV1
constexpr std::uint16_t kVersion = 1;
constexpr std::uint16_t kStatus = 1, kCommand = 2, kAck = 3;
constexpr std::size_t kHeaderSize = 16, kStatusSize = 70, kCommandSize = 8;

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
std::uint16_t Get16(const std::uint8_t* p) { std::uint16_t v; std::memcpy(&v,p,2); return ntohs(v); }
std::uint32_t Get32(const std::uint8_t* p) { std::uint32_t v; std::memcpy(&v,p,4); return ntohl(v); }
std::uint64_t NowMs() { return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
  std::chrono::system_clock::now().time_since_epoch()).count()); }

std::vector<std::uint8_t> Header(std::uint16_t type, std::uint32_t length, std::uint32_t sequence) {
  std::vector<std::uint8_t> out; out.reserve(kHeaderSize + length);
  Put32(out, kMagic); Put16(out, kVersion); Put16(out, type); Put32(out, length); Put32(out, sequence);
  return out;
}
bool SendAll(int fd, const std::vector<std::uint8_t>& data) {
  std::size_t sent = 0;
  while (sent < data.size()) {
    const auto count = send(fd, data.data() + sent, data.size() - sent, MSG_NOSIGNAL);
    if (count <= 0) return false;
    sent += static_cast<std::size_t>(count);
  }
  return true;
}
}  // namespace

struct RobotBackendClient::Impl {
  explicit Impl(RobotBackendConfig value) : config(std::move(value)) {}
  RobotBackendConfig config; int fd = -1; std::thread worker; std::mutex mutex;
  LocalizationResult pose; float power = -1.0F, voltage = 0.0F;
  bool mission_running = false;
  std::function<void(MissionCommand)> callback; std::atomic<bool> running{false};
  std::uint32_t sequence = 0; std::vector<std::uint8_t> incoming;
};

RobotBackendClient::RobotBackendClient(RobotBackendConfig config) : impl_(new Impl(std::move(config))) {}
RobotBackendClient::~RobotBackendClient() { Stop(); }

void RobotBackendClient::Start() {
  if (impl_->running.exchange(true)) return;
  impl_->worker = std::thread([this] {
    while (impl_->running) {
      if (impl_->fd < 0) {
        impl_->fd = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(impl_->config.backend_port);
        if (impl_->fd < 0 || inet_pton(AF_INET, impl_->config.backend_host.c_str(), &address.sin_addr) != 1 ||
            connect(impl_->fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
          if (impl_->fd >= 0) close(impl_->fd);
          impl_->fd = -1;
          std::this_thread::sleep_for(std::chrono::seconds(1)); continue;
        }
        int enabled = 1; setsockopt(impl_->fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
        timeval timeout{0, 1000}; setsockopt(impl_->fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        impl_->incoming.clear();
      }

      LocalizationResult pose; float power, voltage; bool mission_running;
      { std::lock_guard<std::mutex> lock(impl_->mutex); pose=impl_->pose; power=impl_->power;
        voltage=impl_->voltage; mission_running=impl_->mission_running; }
      auto frame = Header(kStatus, kStatusSize, ++impl_->sequence);
      char id[32]{}; std::strncpy(id, impl_->config.robot_id.c_str(), sizeof(id)-1);
      frame.insert(frame.end(), id, id + sizeof(id)); Put64(frame, NowMs());
      PutFloat(frame, pose.pose.x); PutFloat(frame, pose.pose.y); PutFloat(frame, pose.pose.yaw);
      PutFloat(frame, pose.score); PutFloat(frame, power); PutFloat(frame, voltage);
      frame.push_back(pose.valid ? 1 : 0); frame.push_back(pose.global_search ? 1 : 0);
      frame.push_back(mission_running ? 1 : 0); frame.insert(frame.end(), 3, 0);
      if (!SendAll(impl_->fd, frame)) { close(impl_->fd); impl_->fd=-1; continue; }

      std::uint8_t chunk[256]; const auto count = recv(impl_->fd, chunk, sizeof(chunk), 0);
      if (count > 0) impl_->incoming.insert(impl_->incoming.end(), chunk, chunk + count);
      else if (count == 0) { close(impl_->fd); impl_->fd=-1; continue; }
      while (impl_->incoming.size() >= kHeaderSize) {
        const auto* p = impl_->incoming.data();
        if (Get32(p) != kMagic || Get16(p+4) != kVersion) { impl_->incoming.erase(impl_->incoming.begin()); continue; }
        const auto type = Get16(p + 6);
        const auto length = Get32(p + 8);
        const auto seq = Get32(p + 12);
        if (length > 1024) { close(impl_->fd); impl_->fd=-1; impl_->incoming.clear(); break; }
        if (impl_->incoming.size() < kHeaderSize + length) break;
        if (type == kCommand && length == kCommandSize) {
          const auto command = impl_->incoming[kHeaderSize] == 1 ? MissionCommand::Start : MissionCommand::Stop;
          std::function<void(MissionCommand)> callback;
          { std::lock_guard<std::mutex> lock(impl_->mutex); callback=impl_->callback; }
          if (callback) callback(command);
          auto ack=Header(kAck,kCommandSize,seq); ack.insert(ack.end(),impl_->incoming.begin()+kHeaderSize,
            impl_->incoming.begin()+kHeaderSize+kCommandSize); SendAll(impl_->fd,ack);
        }
        impl_->incoming.erase(impl_->incoming.begin(), impl_->incoming.begin()+kHeaderSize+length);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(impl_->config.period_ms));
    }
  });
}
void RobotBackendClient::Stop() noexcept {
  if (!impl_ || !impl_->running.exchange(false)) return;
  if (impl_->fd >= 0) shutdown(impl_->fd, SHUT_RDWR);
  if (impl_->worker.joinable()) impl_->worker.join();
  if (impl_->fd >= 0) close(impl_->fd);
  impl_->fd = -1;
}
void RobotBackendClient::UpdatePose(const LocalizationResult& value){std::lock_guard<std::mutex>l(impl_->mutex);impl_->pose=value;}
void RobotBackendClient::UpdatePower(float percent,float voltage){std::lock_guard<std::mutex>l(impl_->mutex);impl_->power=percent;impl_->voltage=voltage;}
void RobotBackendClient::UpdateMissionRunning(bool running){std::lock_guard<std::mutex>l(impl_->mutex);impl_->mission_running=running;}
void RobotBackendClient::SetMissionCallback(std::function<void(MissionCommand)> value){std::lock_guard<std::mutex>l(impl_->mutex);impl_->callback=std::move(value);}
}  // namespace luckfox
