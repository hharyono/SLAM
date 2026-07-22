#include "luckfox/localizer.hpp"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <iostream>

int main() {
  luckfox::SlamMap original;
  original.width = 32; original.height = 24; original.resolution = 0.1F;
  original.origin_x = -1.0F; original.origin_y = -1.0F;
  original.occupancy.assign(original.width * original.height, 0);
  luckfox::MapLevel level{original.width, original.height, original.resolution,
                          std::vector<std::uint8_t>(original.width * original.height, 0)};
  const auto mark = [&](int x, int y) {
    original.occupancy[static_cast<std::size_t>(y) * original.width + x] = 1;
    level.likelihood[static_cast<std::size_t>(y) * level.width + x] = 255;
  };
  mark(15, 10); mark(20, 12); mark(13, 17); mark(24, 16);
  original.levels.push_back(level);
  const char* path = "/tmp/luckfox_map_test.bin";
  luckfox::SaveMap(original, path);
  const auto loaded = luckfox::LoadMap(path);
  assert(loaded.width == original.width && loaded.height == original.height);
  assert(loaded.occupancy == original.occupancy);
  assert(loaded.levels[0].likelihood == original.levels[0].likelihood);

  const luckfox::Pose2f truth{0.5F, 0.4F, 0.0F};
  std::vector<luckfox::Point2f> scan{{0.0F,-0.4F},{0.5F,-0.2F},{-0.2F,0.3F},{0.9F,0.2F}};
  luckfox::SearchOptions options;
  options.linear_window = 0.4F; options.angular_window = 0.0F;
  options.linear_step = 0.1F; options.angular_step = 0.01F; options.minimum_score = 0.9F;
  const auto result = luckfox::Localize(loaded, scan, {0.3F,0.2F,0.0F}, options);
  assert(result.valid);
  assert(std::fabs(result.pose.x - truth.x) < 0.06F);
  assert(std::fabs(result.pose.y - truth.y) < 0.06F);
  auto single_resolution = options;
  single_resolution.use_multi_resolution = false;
  const auto single_result = luckfox::Localize(
      loaded, scan, {0.3F, 0.2F, 0.0F}, single_resolution);
  assert(single_result.valid);

  luckfox::StateOptions state_options;
  state_options.lost_after_rejections = 2;
  state_options.recovery_confirmations = 2;
  luckfox::PoseTracker tracker(options, state_options);
  auto tracked = tracker.Update(loaded, scan);
  assert(tracked.valid);
  assert(tracked.state == luckfox::LocalizationState::Recovered);
  tracked = tracker.Update(loaded, scan);
  assert(tracked.state == luckfox::LocalizationState::Recovered);
  tracked = tracker.Update(loaded, scan);
  assert(tracked.state == luckfox::LocalizationState::Tracking);

  const std::vector<luckfox::Point2f> invalid_scan{
      {100.0F, 100.0F}, {101.0F, 100.0F}, {100.0F, 101.0F}};
  tracked = tracker.Update(loaded, invalid_scan);
  assert(!tracked.valid);
  assert(tracked.state == luckfox::LocalizationState::Degraded);
  tracked = tracker.Update(loaded, invalid_scan);
  assert(tracked.state == luckfox::LocalizationState::Lost);
  assert(!tracker.has_pose());
  tracked = tracker.Update(loaded, scan);
  assert(tracked.valid);
  assert(tracked.global_search);
  assert(tracked.state == luckfox::LocalizationState::Recovered);
  assert(std::string(luckfox::LocalizationStateName(tracked.state)) == "RECOVERED");

  auto local_only_state = state_options;
  local_only_state.enable_global_relocalization = false;
  luckfox::PoseTracker local_only_tracker(options, local_only_state);
  local_only_tracker.Update(loaded, scan);
  local_only_tracker.Update(loaded, scan);
  local_only_tracker.Update(loaded, scan);
  local_only_tracker.Update(loaded, invalid_scan);
  const auto local_only_lost = local_only_tracker.Update(loaded, invalid_scan);
  assert(local_only_lost.state == luckfox::LocalizationState::Lost);
  assert(local_only_tracker.has_pose());
  const auto local_only_retry = local_only_tracker.Update(loaded, scan);
  assert(!local_only_retry.global_search);
  std::remove(path);
  std::cout << "map_tests passed\n";
}
