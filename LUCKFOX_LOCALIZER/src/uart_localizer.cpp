#include "luckfox/uart_localizer.hpp"

#include "CYdLidar.h"

#include <cmath>
#include <stdexcept>
#include <utility>
#include <vector>

namespace luckfox {

struct UartLocalizer::Impl {
  Impl(SlamMap input_map, UartLidarConfig input_lidar, SearchOptions input_search)
      : map(std::move(input_map)), config(std::move(input_lidar)), search(input_search) {}

  SlamMap map;
  UartLidarConfig config;
  SearchOptions search;
  CYdLidar laser;
  Pose2f last_pose{};
  bool has_pose = false;
  bool running = false;
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
                             SearchOptions search)
    : impl_(new Impl(std::move(map), std::move(lidar), search)) {}

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

LocalizationResult UartLocalizer::LocalizeNext(const Pose2f& fallback_initial) {
  if (!impl_->running) throw std::runtime_error("UART localizer is not started");

  LaserScan scan;
  if (!impl_->laser.doProcessSimple(scan))
    throw std::runtime_error(std::string("failed to read YDLidar scan: ") +
                             impl_->laser.DescribeError());

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
  if (points.size() < 3) throw std::runtime_error("YDLidar scan has too few valid points");

  const Pose2f initial = impl_->has_pose ? impl_->last_pose : fallback_initial;
  auto result = Localize(impl_->map, points, initial, impl_->search);
  if (result.valid) {
    impl_->last_pose = result.pose;
    impl_->has_pose = true;
  }
  return result;
}

}  // namespace luckfox
