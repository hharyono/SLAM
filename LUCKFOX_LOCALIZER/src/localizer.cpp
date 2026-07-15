#include "luckfox/localizer.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace luckfox {
namespace {

float Score(const MapLevel& level, float origin_x, float origin_y, float origin_yaw,
            const std::vector<Point2f>& scan, const Pose2f& pose) {
  const float cp = std::cos(pose.yaw), sp = std::sin(pose.yaw);
  const float co = std::cos(origin_yaw), so = std::sin(origin_yaw);
  std::uint64_t total = 0;
  std::uint32_t inside = 0;
  for (const auto& point : scan) {
    const float wx = pose.x + cp * point.x - sp * point.y;
    const float wy = pose.y + sp * point.x + cp * point.y;
    const float dx = wx - origin_x, dy = wy - origin_y;
    const float mx = (co * dx + so * dy) / level.resolution;
    const float my = (-so * dx + co * dy) / level.resolution;
    const int ix = static_cast<int>(std::floor(mx));
    const int iy = static_cast<int>(std::floor(my));
    if (ix >= 0 && iy >= 0 && ix < static_cast<int>(level.width) && iy < static_cast<int>(level.height)) {
      total += level.likelihood[static_cast<std::size_t>(iy) * level.width + ix];
      ++inside;
    }
  }
  if (inside < std::max<std::uint32_t>(3, static_cast<std::uint32_t>(scan.size() / 3))) return 0.0F;
  return static_cast<float>(total) / (255.0F * static_cast<float>(scan.size()));
}

struct Candidate { Pose2f pose; float score; };

void KeepBest(std::vector<Candidate>* candidates, std::size_t count) {
  std::sort(candidates->begin(), candidates->end(),
            [](const Candidate& a, const Candidate& b) { return a.score > b.score; });
  if (candidates->size() > count) candidates->resize(count);
}

}  // namespace

LocalizationResult Localize(const SlamMap& map, const std::vector<Point2f>& scan,
                            const Pose2f& initial, const SearchOptions& options) {
  LocalizationResult result;
  result.pose = initial;
  if (scan.empty() || map.levels.empty()) return result;

  Pose2f center = initial;
  float window_xy = options.linear_window;
  float window_yaw = options.angular_window;
  for (std::size_t reverse = map.levels.size(); reverse-- > 0;) {
    const auto& level = map.levels[reverse];
    const float step_xy = std::max(options.linear_step, level.resolution);
    const float step_yaw = std::max(options.angular_step,
      options.angular_step * static_cast<float>(std::uint32_t{1} << std::min<std::size_t>(reverse, 8)));
    float best = -std::numeric_limits<float>::infinity();
    Pose2f best_pose = center;
    for (float yaw = center.yaw - window_yaw; yaw <= center.yaw + window_yaw + 0.5F * step_yaw; yaw += step_yaw)
      for (float y = center.y - window_xy; y <= center.y + window_xy + 0.5F * step_xy; y += step_xy)
        for (float x = center.x - window_xy; x <= center.x + window_xy + 0.5F * step_xy; x += step_xy) {
          const Pose2f candidate{x, y, yaw};
          const float score = Score(level, map.origin_x, map.origin_y, map.origin_yaw, scan, candidate);
          ++result.evaluated;
          if (score > best) { best = score; best_pose = candidate; }
        }
    center = best_pose;
    result.score = best;
    window_xy = std::max(step_xy, level.resolution * 1.5F);
    window_yaw = std::max(step_yaw, options.angular_step * 1.5F);
  }
  result.pose = center;
  result.valid = result.score >= options.minimum_score;
  return result;
}

LocalizationResult GlobalLocalize(const SlamMap& map,
                                  const std::vector<Point2f>& scan,
                                  const SearchOptions& options) {
  LocalizationResult result;
  result.global_search = true;
  if (scan.empty() || map.levels.empty()) return result;

  constexpr float kPi = 3.14159265358979323846F;
  constexpr std::size_t kKeep = 12;
  const std::size_t coarse_index = map.levels.size() - 1;
  const auto& coarse = map.levels[coarse_index];
  const float coarse_yaw_step = 10.0F * kPi / 180.0F;
  const float co = std::cos(map.origin_yaw), so = std::sin(map.origin_yaw);
  std::vector<Candidate> candidates;
  candidates.reserve(static_cast<std::size_t>(coarse.width) * coarse.height * 36);

  for (float yaw = -kPi; yaw < kPi - 0.5F * coarse_yaw_step; yaw += coarse_yaw_step)
    for (std::uint32_t iy = 0; iy < coarse.height; ++iy)
      for (std::uint32_t ix = 0; ix < coarse.width; ++ix) {
        const float mx = (static_cast<float>(ix) + 0.5F) * coarse.resolution;
        const float my = (static_cast<float>(iy) + 0.5F) * coarse.resolution;
        const Pose2f pose{map.origin_x + co * mx - so * my,
                          map.origin_y + so * mx + co * my, yaw};
        candidates.push_back({pose, Score(coarse, map.origin_x, map.origin_y,
                                          map.origin_yaw, scan, pose)});
        ++result.evaluated;
      }
  KeepBest(&candidates, kKeep);

  float previous_xy_step = coarse.resolution;
  float previous_yaw_step = coarse_yaw_step;
  for (std::size_t reverse = coarse_index; reverse-- > 0;) {
    const auto& level = map.levels[reverse];
    const float xy_step = std::max(options.linear_step, level.resolution);
    const float yaw_step = std::max(options.angular_step, previous_yaw_step * 0.5F);
    std::vector<Candidate> refined;
    for (const auto& parent : candidates)
      for (float dyaw = -previous_yaw_step; dyaw <= previous_yaw_step + 0.5F * yaw_step;
           dyaw += yaw_step)
        for (float dy = -previous_xy_step; dy <= previous_xy_step + 0.5F * xy_step;
             dy += xy_step)
          for (float dx = -previous_xy_step; dx <= previous_xy_step + 0.5F * xy_step;
               dx += xy_step) {
            Pose2f pose{parent.pose.x + dx, parent.pose.y + dy, parent.pose.yaw + dyaw};
            while (pose.yaw > kPi) pose.yaw -= 2.0F * kPi;
            while (pose.yaw < -kPi) pose.yaw += 2.0F * kPi;
            refined.push_back({pose, Score(level, map.origin_x, map.origin_y,
                                            map.origin_yaw, scan, pose)});
            ++result.evaluated;
          }
    KeepBest(&refined, kKeep);
    candidates.swap(refined);
    previous_xy_step = xy_step;
    previous_yaw_step = yaw_step;
  }

  if (!candidates.empty()) {
    result.pose = candidates.front().pose;
    result.score = candidates.front().score;
    result.valid = result.score >= options.minimum_score;
  }
  return result;
}

}  // namespace luckfox
