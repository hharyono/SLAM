#include "luckfox/uart_localizer.hpp"

#include "CYdLidar.h"

#include <cmath>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>

namespace luckfox {

struct UartLocalizer::Impl {
  Impl(SlamMap input_map, UartLidarConfig input_lidar,
       SearchOptions input_search, StateOptions input_state)
      : map(std::move(input_map)), config(std::move(input_lidar)),
        tracker(input_search, input_state) {}

  SlamMap map;
  UartLidarConfig config;
  PoseTracker tracker;
  CYdLidar laser;
  bool running = false;
  std::mutex localization_mutex;
};

namespace {

template <typename T>
void SetOption(CYdLidar& laser, int property, const T& value,
               const char* description) {
  if (!laser.setlidaropt(property, &value, sizeof(value)))
    throw std::runtime_error(std::string("cannot set YDLidar option: ") + description);
}

}  // namespace

UartLocalizer::UartLocalizer(SlamMap map, UartLidarConfig lidar,
                             SearchOptions search, StateOptions state)
    : impl_(new Impl(std::move(map), std::move(lidar), search, state)) {}

UartLocalizer::~UartLocalizer() { Stop(); }

void UartLocalizer::Start() {
  if (impl_->running) return;
  ydlidar::os_init();

  auto& laser = impl_->laser;
  const auto& cfg = impl_->config;
  if (!laser.setlidaropt(LidarPropSerialPort, cfg.port.c_str(), cfg.port.size()))
    throw std::runtime_error("cannot set YDLidar UART port");

  const std::string ignore;
  laser.setlidaropt(LidarPropIgnoreArray, ignore.c_str(), ignore.size());
  SetOption(laser, LidarPropSerialBaudrate, cfg.baudrate, "baudrate");
  SetOption(laser, LidarPropLidarType, cfg.lidar_type, "lidar type");
  SetOption(laser, LidarPropDeviceType, cfg.device_type, "device type");
  SetOption(laser, LidarPropSampleRate, cfg.sample_rate, "sample rate");
  SetOption(laser, LidarPropIntenstiyBit, cfg.intensity_bit, "intensity bit");
  SetOption(laser, LidarPropAbnormalCheckCount, cfg.abnormal_check_count,
            "abnormal checks");
  SetOption(laser, LidarPropScanFrequency, cfg.scan_frequency, "frequency");
  SetOption(laser, LidarPropMinRange, cfg.minimum_range, "minimum range");
  SetOption(laser, LidarPropMaxRange, cfg.maximum_range, "maximum range");
  SetOption(laser, LidarPropSingleChannel, cfg.single_channel, "single channel");
  SetOption(laser, LidarPropIntenstiy, cfg.intensity, "intensity");
  SetOption(laser, LidarPropSupportMotorDtrCtrl, cfg.motor_dtr, "motor DTR");
  SetOption(laser, LidarPropAutoReconnect, cfg.auto_reconnect, "auto reconnect");

  SetOption(laser, LidarPropFixedResolution, cfg.fixed_resolution,
            "fixed resolution");
  SetOption(laser, LidarPropReversion, cfg.reversion, "reversion");
  SetOption(laser, LidarPropInverted, cfg.inverted, "inverted");
  SetOption(laser, LidarPropMinAngle, cfg.minimum_angle, "minimum angle");
  SetOption(laser, LidarPropMaxAngle, cfg.maximum_angle, "maximum angle");

  if (!laser.initialize())
    throw std::runtime_error(std::string("YDLidar initialize failed: ") + laser.DescribeError());
  if (!laser.turnOn()) {
    laser.disconnecting();
    throw std::runtime_error(std::string("YDLidar start failed: ") + laser.DescribeError());
  }
  impl_->running = true;
}

void UartLocalizer::Stop() noexcept {
  if (!impl_ || !impl_->running) return;
  impl_->laser.turnOff();
  impl_->laser.disconnecting();
  impl_->running = false;
}

bool UartLocalizer::IsRunning() const noexcept { return impl_->running; }

void UartLocalizer::ReloadMap(SlamMap map) {
  std::lock_guard<std::mutex> lock(impl_->localization_mutex);
  impl_->map = std::move(map);
  impl_->tracker.Reset("map_reloaded");
}

LocalizationResult UartLocalizer::LocalizeNext(const Pose2f& fallback_initial,
                                               CapturedScan* captured_scan) {
  if (!impl_->running) throw std::runtime_error("UART localizer is not started");

  LaserScan scan;
  if (!impl_->laser.doProcessSimple(scan))
    throw std::runtime_error(std::string("failed to read YDLidar scan: ") +
                             impl_->laser.DescribeError());

  if (captured_scan) {
    captured_scan->stamp_ns = scan.stamp;
    captured_scan->angle_min = scan.config.min_angle;
    captured_scan->angle_max = scan.config.max_angle;
    captured_scan->angle_increment = scan.config.angle_increment;
    captured_scan->time_increment = scan.config.time_increment;
    captured_scan->scan_time = scan.config.scan_time;
    captured_scan->range_min = scan.config.min_range;
    captured_scan->range_max = scan.config.max_range;
    captured_scan->samples.clear();
    captured_scan->samples.reserve(scan.points.size());
    for (const auto& point : scan.points)
      captured_scan->samples.push_back({point.angle, point.range, point.intensity});
  }

  std::vector<Point2f> points;
  points.reserve(scan.points.size());
  for (const auto& sample : scan.points) {
    if (!std::isfinite(sample.angle) || !std::isfinite(sample.range) ||
        sample.range < impl_->config.minimum_range ||
        sample.range > impl_->config.maximum_range)
      continue;
    points.push_back({sample.range * std::cos(sample.angle),
                      sample.range * std::sin(sample.angle)});
  }
  (void)fallback_initial;
  std::lock_guard<std::mutex> lock(impl_->localization_mutex);
  return impl_->tracker.Update(impl_->map, points);
}

}  // namespace luckfox
