#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace luckfox {

constexpr std::uint32_t kMapVersion = 1;

struct MapLevel {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  float resolution = 0.0F;
  std::vector<std::uint8_t> likelihood;
};

struct SlamMap {
  float origin_x = 0.0F;
  float origin_y = 0.0F;
  float origin_yaw = 0.0F;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  float resolution = 0.0F;
  std::vector<std::uint8_t> occupancy;  // 0 free, 1 occupied, 2 unknown
  std::vector<MapLevel> levels;
};

SlamMap LoadMap(const std::string& path);
void SaveMap(const SlamMap& map, const std::string& path);
std::uint32_t Crc32(const std::uint8_t* data, std::size_t size);

}  // namespace luckfox
