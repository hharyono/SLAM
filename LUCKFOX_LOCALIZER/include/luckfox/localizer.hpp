#pragma once

#include "luckfox/map.hpp"

#include <vector>

namespace luckfox {

struct Point2f { float x = 0.0F; float y = 0.0F; };
struct Pose2f { float x = 0.0F; float y = 0.0F; float yaw = 0.0F; };

struct SearchOptions {
  float linear_window = 0.5F;
  float angular_window = 0.35F;
  float linear_step = 0.05F;
  float angular_step = 0.0174532925F;
  float minimum_score = 0.35F;
};

struct LocalizationResult {
  Pose2f pose;
  float score = 0.0F;
  bool valid = false;
  std::uint32_t evaluated = 0;
  bool global_search = false;
};

LocalizationResult Localize(const SlamMap& map,
                            const std::vector<Point2f>& scan,
                            const Pose2f& initial,
                            const SearchOptions& options = {});

LocalizationResult GlobalLocalize(const SlamMap& map,
                                  const std::vector<Point2f>& scan,
                                  const SearchOptions& options = {});

}  // namespace luckfox
