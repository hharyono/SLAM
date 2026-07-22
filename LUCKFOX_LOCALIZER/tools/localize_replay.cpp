#include "luckfox/localizer.hpp"
#include "luckfox/map.hpp"

#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

float EnvironmentFloat(const char* name, float fallback) {
  const char* value = std::getenv(name);
  return value ? std::stof(value) : fallback;
}

unsigned EnvironmentUnsigned(const char* name, unsigned fallback) {
  const char* value = std::getenv(name);
  return value ? static_cast<unsigned>(std::stoul(value)) : fallback;
}

struct ScanGroup {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_ns = 0;
  std::uint32_t raw_points = 0;
  std::vector<luckfox::Point2f> points;
};

void Emit(const luckfox::SlamMap& map, luckfox::PoseTracker* tracker,
          const ScanGroup& scan, const std::string& variant) {
  if (scan.raw_points == 0) return;
  auto result = tracker->Update(map, scan.points);
  std::cout << std::setprecision(9)
            << "{\"schema\":\"luckfox.localization.replay.v1\""
            << ",\"variant\":\"" << variant << "\""
            << ",\"sequence\":" << scan.sequence
            << ",\"timestamp_unix_ms\":" << scan.timestamp_ns / 1000000ULL
            << ",\"scan_timestamp_ns\":" << scan.timestamp_ns
            << ",\"x_m\":" << result.pose.x
            << ",\"y_m\":" << result.pose.y
            << ",\"yaw_rad\":" << result.pose.yaw
            << ",\"score\":" << result.score
            << ",\"mode\":\"" << (result.global_search ? "global" : "tracking") << "\""
            << ",\"state\":\"" << luckfox::LocalizationStateName(result.state) << "\""
            << ",\"previous_state\":\""
            << luckfox::LocalizationStateName(result.previous_state) << "\""
            << ",\"accepted\":" << (result.valid ? "true" : "false")
            << ",\"candidate_count\":" << result.evaluated
            << ",\"valid_scan_points\":" << result.valid_scan_points
            << ",\"raw_scan_points\":" << scan.raw_points
            << ",\"matcher_execution_us\":" << result.execution_time_us
            << ",\"transition_reason\":\"" << result.transition_reason << "\""
            << ",\"consecutive_rejections\":" << result.consecutive_rejections
            << ",\"recovery_confirmations\":" << result.recovery_confirmations
            << "}\n";
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc != 3 && argc != 5) {
    std::cerr << "Usage: localize_replay MAP.bin raw_scans.csv "
                 "[--mode local_only|local_global|single_resolution|multi_resolution] "
                 "> replay.jsonl\n";
    return 2;
  }
  const std::string variant = argc == 5 ? argv[4] : "local_global";
  if (argc == 5 && std::string(argv[3]) != "--mode")
    throw std::runtime_error("expected --mode before replay variant");
  if (variant != "local_only" && variant != "local_global" &&
      variant != "single_resolution" && variant != "multi_resolution")
    throw std::runtime_error("invalid replay variant: " + variant);
  const auto map = luckfox::LoadMap(argv[1]);
  luckfox::SearchOptions search;
  search.linear_window = EnvironmentFloat("LUCKFOX_LINEAR_WINDOW_M", search.linear_window);
  search.angular_window = EnvironmentFloat("LUCKFOX_ANGULAR_WINDOW_RAD", search.angular_window);
  search.linear_step = EnvironmentFloat("LUCKFOX_LINEAR_STEP_M", search.linear_step);
  search.angular_step = EnvironmentFloat("LUCKFOX_ANGULAR_STEP_RAD", search.angular_step);
  search.minimum_score = EnvironmentFloat("LUCKFOX_MINIMUM_SCORE", search.minimum_score);
  search.use_multi_resolution = variant != "single_resolution";
  luckfox::StateOptions state;
  state.lost_after_rejections = EnvironmentUnsigned(
      "LUCKFOX_LOST_AFTER_REJECTIONS", state.lost_after_rejections);
  state.recovery_confirmations = EnvironmentUnsigned(
      "LUCKFOX_RECOVERY_CONFIRMATIONS", state.recovery_confirmations);
  state.enable_global_relocalization = variant != "local_only";
  luckfox::PoseTracker tracker(search, state);
  const float minimum_range = EnvironmentFloat("LUCKFOX_MINIMUM_RANGE_M", 0.05F);
  const float maximum_range = EnvironmentFloat("LUCKFOX_MAXIMUM_RANGE_M", 12.0F);

  std::ifstream input(argv[2]);
  if (!input) throw std::runtime_error(std::string("cannot open ") + argv[2]);
  std::string line;
  std::getline(input, line);  // CSV header.
  ScanGroup group;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    for (char& character : line) if (character == ',') character = ' ';
    std::istringstream row(line);
    std::uint64_t sequence = 0, timestamp_ns = 0;
    float angle = 0.0F, range = 0.0F, intensity = 0.0F;
    if (!(row >> sequence >> timestamp_ns >> angle >> range >> intensity))
      throw std::runtime_error("invalid raw scan CSV row");
    (void)intensity;
    if (group.raw_points && sequence != group.sequence) {
      Emit(map, &tracker, group, variant);
      group = {};
    }
    group.sequence = sequence;
    group.timestamp_ns = timestamp_ns;
    ++group.raw_points;
    if (std::isfinite(angle) && std::isfinite(range) &&
        range >= minimum_range && range <= maximum_range)
      group.points.push_back({range * std::cos(angle), range * std::sin(angle)});
  }
  Emit(map, &tracker, group, variant);
  return 0;
} catch (const std::exception& error) {
  std::cerr << "localize_replay: " << error.what() << '\n';
  return 1;
}
