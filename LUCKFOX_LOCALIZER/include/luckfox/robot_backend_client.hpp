#pragma once

#include "luckfox/localizer.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace luckfox {

enum class MissionCommand { Start, Stop };

struct RobotBackendConfig {
  std::string robot_id = "AGV-001";
  std::string backend_host = "127.0.0.1";
  std::uint16_t backend_port = 42000;
  unsigned period_ms = 250;
};

// Persistent TCP client using a versioned binary framing protocol. Network
// failures never block the localization thread and reconnect automatically.
class RobotBackendClient {
 public:
  explicit RobotBackendClient(RobotBackendConfig config = {});
  ~RobotBackendClient();
  RobotBackendClient(const RobotBackendClient&) = delete;
  RobotBackendClient& operator=(const RobotBackendClient&) = delete;

  void Start();
  void Stop() noexcept;
  void UpdatePose(const LocalizationResult& result);
  void UpdatePower(float percent, float voltage = 0.0F);
  void UpdateMissionRunning(bool running);
  void SetMissionCallback(std::function<void(MissionCommand)> callback);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace luckfox
