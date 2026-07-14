#include "luckfox/map.hpp"

#include <algorithm>
#include <iostream>

int main(int argc, char** argv) try {
  if (argc != 2) { std::cerr << "Usage: map_inspect MAP.bin\n"; return 2; }
  const auto map = luckfox::LoadMap(argv[1]);
  const auto occupied = std::count(map.occupancy.begin(), map.occupancy.end(), 1);
  const auto unknown = std::count(map.occupancy.begin(), map.occupancy.end(), 2);
  std::cout << "map.bin v" << luckfox::kMapVersion << '\n'
            << "size: " << map.width << " x " << map.height << '\n'
            << "resolution: " << map.resolution << " m/cell\n"
            << "origin: " << map.origin_x << ", " << map.origin_y << ", " << map.origin_yaw << '\n'
            << "occupied: " << occupied << ", unknown: " << unknown << '\n'
            << "pyramid levels: " << map.levels.size() << '\n';
  for (std::size_t i = 0; i < map.levels.size(); ++i)
    std::cout << "  L" << i << ": " << map.levels[i].width << " x " << map.levels[i].height
              << " @ " << map.levels[i].resolution << " m\n";
  return 0;
} catch (const std::exception& e) {
  std::cerr << "map_inspect: " << e.what() << '\n'; return 1;
}
