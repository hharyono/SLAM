#pragma once

#include "luckfox/localizer.hpp"

#include <memory>
#include <string>

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

  // Blocks until the SDK supplies one complete scan, then localizes it.
  // Globally searches when no pose is known, then tracks from the last pose.
  LocalizationResult LocalizeNext(const Pose2f& fallback_initial);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace luckfox
