#pragma once

#include "luckfox/map.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace luckfox {

struct Point2f { float x = 0.0F; float y = 0.0F; };
struct Pose2f { float x = 0.0F; float y = 0.0F; float yaw = 0.0F; };

struct SearchOptions {
  float linear_window = 0.5F;
  float angular_window = 0.35F;
  float linear_step = 0.05F;
  float angular_step = 0.0174532925F;
  float minimum_score = 0.90F;
  bool use_multi_resolution = true;
};

enum class LocalizationState {
  GlobalSearch,
  Tracking,
  Degraded,
  Lost,
  Recovered,
};

const char* LocalizationStateName(LocalizationState state) noexcept;

struct StateOptions {
  unsigned lost_after_rejections = 3;
  unsigned recovery_confirmations = 3;
  bool enable_global_relocalization = true;
};

struct LocalizationResult {
  Pose2f pose;
  float score = 0.0F;
  bool valid = false;
  std::uint32_t evaluated = 0;
  bool global_search = false;
  LocalizationState state = LocalizationState::GlobalSearch;
  LocalizationState previous_state = LocalizationState::GlobalSearch;
  std::string transition_reason = "initial_state";
  std::uint64_t execution_time_us = 0;
  std::uint32_t valid_scan_points = 0;
  unsigned consecutive_rejections = 0;
  unsigned recovery_confirmations = 0;
};

// Stateful quality gate around the existing global/local correlative matcher.
// It does not alter candidate generation or scoring; it only makes pose
// acceptance, degradation, loss, and recovery explicit and reproducible.
class PoseTracker {
 public:
  PoseTracker(SearchOptions search = {}, StateOptions state = {});

  LocalizationResult Update(const SlamMap& map,
                            const std::vector<Point2f>& scan);
  void Reset(const char* reason = "tracker_reset");
  LocalizationState state() const noexcept { return state_; }
  bool has_pose() const noexcept { return has_pose_; }

 private:
  SearchOptions search_;
  StateOptions options_;
  Pose2f last_pose_{};
  LocalizationState state_ = LocalizationState::GlobalSearch;
  bool has_pose_ = false;
  bool ever_had_pose_ = false;
  unsigned consecutive_rejections_ = 0;
  unsigned recovery_confirmations_ = 0;
  std::string reset_reason_ = "initial_state";
};

LocalizationResult Localize(const SlamMap& map,
                            const std::vector<Point2f>& scan,
                            const Pose2f& initial,
                            const SearchOptions& options = {});

LocalizationResult GlobalLocalize(const SlamMap& map,
                                  const std::vector<Point2f>& scan,
                                  const SearchOptions& options = {});

}  // namespace luckfox
