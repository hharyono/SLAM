#include "luckfox/telemetry.hpp"

#include <algorithm>
#include <cmath>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <limits>
#include <stdexcept>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

namespace luckfox {
namespace {

constexpr float kPi = 3.14159265358979323846F;
constexpr float kObstacleCenterHalfAngleDegrees = 10.0F;
constexpr float kObstacleSideLimitAngleDegrees = 65.0F;
constexpr float kObstacleNearMinimumM = 0.30F;
constexpr float kObstacleNearMaximumM = 0.80F;

std::string EscapeJson(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  for (const char character : input) {
    switch (character) {
      case '\\': output += "\\\\"; break;
      case '"': output += "\\\""; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default: output += character; break;
    }
  }
  return output;
}

std::uint64_t TimevalUs(const timeval& value) {
  return static_cast<std::uint64_t>(value.tv_sec) * 1000000ULL +
         static_cast<std::uint64_t>(value.tv_usec);
}

std::uint64_t CurrentRssKb() {
  std::ifstream input("/proc/self/statm");
  std::uint64_t total_pages = 0, resident_pages = 0;
  if (!(input >> total_pages >> resident_pages)) return 0;
  (void)total_pages;
  return resident_pages * static_cast<std::uint64_t>(sysconf(_SC_PAGESIZE)) / 1024ULL;
}

std::uint64_t SteadyUs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
}

std::uint64_t UnixMs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());
}

struct FrontObstacleSignature {
  std::uint32_t left_near_points = 0;
  std::uint32_t center_near_points = 0;
  std::uint32_t right_near_points = 0;
  float minimum_range_m = std::numeric_limits<float>::infinity();
};

FrontObstacleSignature MeasureFrontObstacle(const CapturedScan& scan) {
  constexpr float kCenterHalfAngle =
      kObstacleCenterHalfAngleDegrees * kPi / 180.0F;
  constexpr float kSideLimitAngle =
      kObstacleSideLimitAngleDegrees * kPi / 180.0F;
  FrontObstacleSignature signature;
  for (const auto& sample : scan.samples) {
    if (!std::isfinite(sample.range) || sample.range <= 0.0F) continue;
    const float angle = std::atan2(std::sin(sample.angle), std::cos(sample.angle));
    if (std::abs(angle) > kSideLimitAngle) continue;
    signature.minimum_range_m = std::min(signature.minimum_range_m, sample.range);
    if (sample.range < kObstacleNearMinimumM ||
        sample.range > kObstacleNearMaximumM)
      continue;
    if (angle > kCenterHalfAngle)
      ++signature.left_near_points;
    else if (angle < -kCenterHalfAngle)
      ++signature.right_near_points;
    else
      ++signature.center_near_points;
  }
  return signature;
}

}  // namespace

TelemetryLogger::TelemetryLogger(std::string telemetry_path,
                                 std::string raw_scan_path,
                                 std::string experiment_id,
                                 std::string experiment_condition,
                                 std::string experiment_run_type,
                                 std::string experiment_route_id)
    : experiment_id_(std::move(experiment_id)),
      experiment_condition_(std::move(experiment_condition)),
      experiment_run_type_(std::move(experiment_run_type)),
      experiment_route_id_(std::move(experiment_route_id)) {
  if (!telemetry_path.empty()) {
    telemetry_.open(telemetry_path, std::ios::app);
    if (!telemetry_) throw std::runtime_error("cannot open telemetry log: " + telemetry_path);
  }
  if (!raw_scan_path.empty()) {
    struct stat status{};
    const bool needs_header = stat(raw_scan_path.c_str(), &status) != 0 ||
                              status.st_size == 0;
    raw_scan_.open(raw_scan_path, std::ios::app);
    if (!raw_scan_) throw std::runtime_error("cannot open raw scan log: " + raw_scan_path);
    if (needs_header)
      raw_scan_ << "scan_sequence,timestamp_ns,angle_rad,range_m,intensity\n";
  }
}

void TelemetryLogger::LogConfiguration(const UartLidarConfig& lidar,
                                       const SearchOptions& search,
                                       const StateOptions& state) {
  if (!telemetry_) return;
  telemetry_ << std::setprecision(9)
    << "{\"schema\":\"luckfox.localization.config.v1\""
    << ",\"experiment_id\":\"" << EscapeJson(experiment_id_) << "\""
    << ",\"experiment_condition\":\"" << EscapeJson(experiment_condition_) << "\""
    << ",\"experiment_run_type\":\"" << EscapeJson(experiment_run_type_) << "\""
    << ",\"experiment_route_id\":\"" << EscapeJson(experiment_route_id_) << "\""
    << ",\"timestamp_unix_ms\":" << UnixMs()
    << ",\"uart\":\"" << EscapeJson(lidar.port) << "\""
    << ",\"baudrate\":" << lidar.baudrate
    << ",\"scan_frequency_hz_configured\":" << lidar.scan_frequency
    << ",\"minimum_range_m\":" << lidar.minimum_range
    << ",\"maximum_range_m\":" << lidar.maximum_range
    << ",\"front_obstacle_center_half_angle_deg\":"
    << kObstacleCenterHalfAngleDegrees
    << ",\"front_obstacle_side_limit_angle_deg\":"
    << kObstacleSideLimitAngleDegrees
    << ",\"front_obstacle_near_minimum_m\":" << kObstacleNearMinimumM
    << ",\"front_obstacle_near_maximum_m\":" << kObstacleNearMaximumM
    << ",\"linear_window_m\":" << search.linear_window
    << ",\"angular_window_rad\":" << search.angular_window
    << ",\"linear_step_m\":" << search.linear_step
    << ",\"angular_step_rad\":" << search.angular_step
    << ",\"minimum_score\":" << search.minimum_score
    << ",\"multi_resolution\":" << (search.use_multi_resolution ? "true" : "false")
    << ",\"lost_after_rejections\":" << state.lost_after_rejections
    << ",\"recovery_confirmations\":" << state.recovery_confirmations
    << ",\"global_relocalization\":"
    << (state.enable_global_relocalization ? "true" : "false")
    << "}\n";
  telemetry_.flush();
}

void TelemetryLogger::LogResource(const char* operating_state) {
  if (!telemetry_) return;
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  const std::uint64_t cpu_us = TimevalUs(usage.ru_utime) + TimevalUs(usage.ru_stime);
  const std::uint64_t wall_us = SteadyUs();
  const std::uint64_t cpu_delta_us = previous_cpu_us_ ? cpu_us - previous_cpu_us_ : 0;
  const std::uint64_t wall_delta_us = previous_wall_us_ ? wall_us - previous_wall_us_ : 0;
  const double cpu_percent = wall_delta_us
      ? 100.0 * static_cast<double>(cpu_delta_us) / static_cast<double>(wall_delta_us)
      : 0.0;
  previous_cpu_us_ = cpu_us;
  previous_wall_us_ = wall_us;
  telemetry_ << std::setprecision(9)
    << "{\"schema\":\"luckfox.localization.resource.v1\""
    << ",\"experiment_id\":\"" << EscapeJson(experiment_id_) << "\""
    << ",\"experiment_condition\":\"" << EscapeJson(experiment_condition_) << "\""
    << ",\"experiment_run_type\":\"" << EscapeJson(experiment_run_type_) << "\""
    << ",\"experiment_route_id\":\"" << EscapeJson(experiment_route_id_) << "\""
    << ",\"timestamp_unix_ms\":" << UnixMs()
    << ",\"operating_state\":\"" << EscapeJson(operating_state ? operating_state : "unknown") << "\""
    << ",\"process_cpu_percent\":" << cpu_percent
    << ",\"rss_kb\":" << CurrentRssKb()
    << ",\"peak_rss_kb\":" << usage.ru_maxrss
    << "}\n";
  telemetry_.flush();
}

void TelemetryLogger::Log(std::uint64_t sequence, const CapturedScan& scan,
                          const LocalizationResult& result,
                          std::uint64_t scan_cycle_us) {
  const FrontObstacleSignature obstacle = MeasureFrontObstacle(scan);
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  const std::uint64_t cpu_us = TimevalUs(usage.ru_utime) + TimevalUs(usage.ru_stime);
  const std::uint64_t wall_us = SteadyUs();
  const std::uint64_t cpu_delta_us = previous_cpu_us_ ? cpu_us - previous_cpu_us_ : 0;
  const std::uint64_t wall_delta_us = previous_wall_us_ ? wall_us - previous_wall_us_ : 0;
  const double cpu_percent = wall_delta_us
      ? 100.0 * static_cast<double>(cpu_delta_us) / static_cast<double>(wall_delta_us)
      : 0.0;
  previous_cpu_us_ = cpu_us;
  previous_wall_us_ = wall_us;

  if (telemetry_) {
    telemetry_ << std::setprecision(9)
      << "{\"schema\":\"luckfox.localization.scan.v1\""
      << ",\"experiment_id\":\"" << EscapeJson(experiment_id_) << "\""
      << ",\"experiment_condition\":\"" << EscapeJson(experiment_condition_) << "\""
      << ",\"experiment_run_type\":\"" << EscapeJson(experiment_run_type_) << "\""
      << ",\"experiment_route_id\":\"" << EscapeJson(experiment_route_id_) << "\""
      << ",\"sequence\":" << sequence
      << ",\"timestamp_unix_ms\":" << UnixMs()
      << ",\"scan_timestamp_ns\":" << scan.stamp_ns
      << ",\"x_m\":" << result.pose.x
      << ",\"y_m\":" << result.pose.y
      << ",\"yaw_rad\":" << result.pose.yaw
      << ",\"score\":" << result.score
      << ",\"mode\":\"" << (result.global_search ? "global" : "tracking") << "\""
      << ",\"state\":\"" << LocalizationStateName(result.state) << "\""
      << ",\"previous_state\":\"" << LocalizationStateName(result.previous_state) << "\""
      << ",\"accepted\":" << (result.valid ? "true" : "false")
      << ",\"candidate_count\":" << result.evaluated
      << ",\"valid_scan_points\":" << result.valid_scan_points
      << ",\"raw_scan_points\":" << scan.samples.size()
      << ",\"front_near_left_points\":" << obstacle.left_near_points
      << ",\"front_near_center_points\":" << obstacle.center_near_points
      << ",\"front_near_right_points\":" << obstacle.right_near_points
      << ",\"front_minimum_range_m\":";
    if (std::isfinite(obstacle.minimum_range_m))
      telemetry_ << obstacle.minimum_range_m;
    else
      telemetry_ << "null";
    telemetry_
      << ",\"matcher_execution_us\":" << result.execution_time_us
      << ",\"scan_cycle_us\":" << scan_cycle_us
      << ",\"transition_reason\":\"" << EscapeJson(result.transition_reason) << "\""
      << ",\"consecutive_rejections\":" << result.consecutive_rejections
      << ",\"recovery_confirmations\":" << result.recovery_confirmations
      << ",\"process_cpu_time_us\":" << cpu_us
      << ",\"process_cpu_delta_us\":" << cpu_delta_us
      << ",\"process_cpu_percent\":" << cpu_percent
      << ",\"rss_kb\":" << CurrentRssKb()
      << ",\"peak_rss_kb\":" << usage.ru_maxrss
      << "}\n";
    telemetry_.flush();
  }

  if (raw_scan_) {
    raw_scan_ << std::setprecision(9);
    for (const auto& sample : scan.samples)
      raw_scan_ << sequence << ',' << scan.stamp_ns << ',' << sample.angle << ','
                << sample.range << ',' << sample.intensity << '\n';
    raw_scan_.flush();
  }
}

}  // namespace luckfox
