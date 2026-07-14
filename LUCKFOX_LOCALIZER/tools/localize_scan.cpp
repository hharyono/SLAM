#include "luckfox/localizer.hpp"

#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::vector<luckfox::Point2f> ReadScan(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot open scan CSV: " + path);
  std::vector<luckfox::Point2f> points;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    for (auto& c : line) if (c == ',') c = ' ';
    float angle = 0.0F, range = 0.0F;
    std::istringstream ss(line);
    if (!(ss >> angle >> range)) throw std::runtime_error("invalid scan CSV line: " + line);
    if (std::isfinite(range) && range > 0.05F)
      points.push_back({range * std::cos(angle), range * std::sin(angle)});
  }
  if (points.empty()) throw std::runtime_error("scan CSV contains no valid points");
  return points;
}
}  // namespace

int main(int argc, char** argv) try {
  if (argc != 6) {
    std::cerr << "Usage: localize_scan MAP.bin SCAN.csv INITIAL_X INITIAL_Y INITIAL_YAW\n"
                 "SCAN.csv rows: angle_radians,range_meters\n";
    return 2;
  }
  const auto map = luckfox::LoadMap(argv[1]);
  const auto scan = ReadScan(argv[2]);
  const luckfox::Pose2f initial{std::stof(argv[3]), std::stof(argv[4]), std::stof(argv[5])};
  const auto result = luckfox::Localize(map, scan, initial);
  std::cout << "x=" << result.pose.x << " y=" << result.pose.y << " yaw=" << result.pose.yaw
            << " score=" << result.score << " valid=" << (result.valid ? 1 : 0)
            << " evaluated=" << result.evaluated << '\n';
  return result.valid ? 0 : 3;
} catch (const std::exception& e) {
  std::cerr << "localize_scan: " << e.what() << '\n'; return 1;
}
