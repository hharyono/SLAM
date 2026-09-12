#pragma once

#include "luckfox/localizer.hpp"
#include <cstdint>
#include <string>
#include <vector>

namespace luckfox {

struct MavlinkConfig {
  std::string port = "/dev/ttyS4";
  unsigned baud = 115200;
  unsigned system_id = 1;       // Match ArduPilot SYSID_THISMAV.
  unsigned component_id = 197; // MAV_COMP_ID_VISUAL_INERTIAL_ODOMETRY.
  // Map is right handed: +yaw is counterclockwise, +Y is left of +X.
  // Heading of map +X measured clockwise from North, in radians.
  float map_heading_rad = 0;
  float origin_x = 0;
  float origin_y = 0;
  std::uint64_t max_age_us = 250000;
};

// Minimal MAVLink 2 common-dialect VISION_POSITION_ESTIMATE encoder.
// Covariance is unknown (NaN): configure measurement noise in ArduPilot.
std::vector<std::uint8_t> EncodeVisionPosition(
    const MavlinkConfig& config, const Pose2f& map_pose,
    std::uint64_t timestamp_us, std::uint8_t sequence,
    std::uint8_t reset_counter);

class MavlinkOutput {
 public:
  explicit MavlinkOutput(MavlinkConfig config);
  ~MavlinkOutput();
  MavlinkOutput(const MavlinkOutput&) = delete;
  MavlinkOutput& operator=(const MavlinkOutput&) = delete;
  // Call for every scan, including rejected scans. No replay of old poses.
  // Returns true only if a complete packet was written. Transport errors throw.
  bool Send(const LocalizationResult& result, std::uint64_t timestamp_us,
            std::uint64_t now_us);
  void Reset() noexcept;

 private:
  MavlinkConfig config_;
  int fd_ = -1;
  std::uint8_t sequence_ = 0;
  std::uint8_t reset_counter_ = 0;
  bool reset_pending_ = true;
  bool sent_ = false;
  std::uint64_t last_timestamp_ = 0;
};
} // namespace luckfox
