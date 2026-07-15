#pragma once

#include "luckfox/localizer.hpp"

#include <memory>
#include <string>
#include <vector>

namespace luckfox {

struct UartLidarConfig {
  std::string port = "/dev/ttyUSB0";
  int baudrate = 230400;
  int lidar_type = 1;
  int device_type = 0;
  int sample_rate = 4;
  int intensity_bit = 8;
  int abnormal_check_count = 4;
  float scan_frequency = 10.0F;
  float minimum_range = 0.05F;
  float maximum_range = 12.0F;
  float minimum_angle = -180.0F;
  float maximum_angle = 180.0F;
  bool single_channel = false;
  bool intensity = true;
  bool fixed_resolution = true;
  bool reversion = true;
  bool inverted = true;
  bool motor_dtr = false;
  bool auto_reconnect = true;
};

struct LidarSample {
  float angle = 0.0F;
  float range = 0.0F;
  float intensity = 0.0F;
};

struct CapturedScan {
  std::uint64_t stamp_ns = 0;
  float angle_min = 0.0F;
  float angle_max = 0.0F;
  float angle_increment = 0.0F;
  float time_increment = 0.0F;
  float scan_time = 0.0F;
  float range_min = 0.0F;
  float range_max = 0.0F;
  std::vector<LidarSample> samples;
};

class UartLocalizer {
 public:
  UartLocalizer(SlamMap map, UartLidarConfig lidar,
                SearchOptions search = {});
  ~UartLocalizer();

  UartLocalizer(const UartLocalizer&) = delete;
  UartLocalizer& operator=(const UartLocalizer&) = delete;

  void Start();
  void Stop() noexcept;
  bool IsRunning() const noexcept;

  // Replaces the active map safely and clears the tracked pose. The next scan
  // performs global localization against the new map.
  void ReloadMap(SlamMap map);

  // Blocks until the SDK supplies one complete scan, then localizes it.
  // Globally searches when no pose is known, then tracks from the last pose.
  LocalizationResult LocalizeNext(const Pose2f& fallback_initial,
                                  CapturedScan* captured_scan = nullptr);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace luckfox
