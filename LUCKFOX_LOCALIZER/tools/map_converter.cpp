#include "luckfox/map.hpp"

#include <algorithm>
#include <cmath>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace {

struct Config {
  std::string image;
  std::string mode = "trinary";
  float resolution = 0.0F;
  float origin_x = 0.0F, origin_y = 0.0F, origin_yaw = 0.0F;
  float occupied_thresh = 0.65F, free_thresh = 0.25F;
  bool negate = false;
};

struct GrayImage {
  std::uint32_t width = 0, height = 0;
  std::vector<std::uint8_t> pixels;
};

std::string Trim(std::string s) {
  const auto first = s.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = s.find_last_not_of(" \t\r\n");
  return s.substr(first, last - first + 1);
}

Config ParseYaml(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot open YAML: " + path);
  Config c;
  std::string line;
  while (std::getline(in, line)) {
    const auto comment = line.find('#');
    if (comment != std::string::npos) line.erase(comment);
    const auto colon = line.find(':');
    if (colon == std::string::npos) continue;
    const auto key = Trim(line.substr(0, colon));
    auto value = Trim(line.substr(colon + 1));
    if (!value.empty() && (value.front() == '\'' || value.front() == '"'))
      value = value.substr(1, value.size() - 2);
    if (key == "image") c.image = value;
    else if (key == "mode") c.mode = value;
    else if (key == "resolution") c.resolution = std::stof(value);
    else if (key == "negate") c.negate = std::stoi(value) != 0;
    else if (key == "occupied_thresh") c.occupied_thresh = std::stof(value);
    else if (key == "free_thresh") c.free_thresh = std::stof(value);
    else if (key == "origin") {
      for (char& ch : value) if (ch == '[' || ch == ']' || ch == ',') ch = ' ';
      std::istringstream ss(value);
      if (!(ss >> c.origin_x >> c.origin_y >> c.origin_yaw))
        throw std::runtime_error("invalid origin in YAML");
    }
  }
  if (c.image.empty() || c.resolution <= 0.0F)
    throw std::runtime_error("YAML requires image and positive resolution");
  return c;
}

std::string NextToken(std::istream& in) {
  std::string token;
  while (in >> token) {
    if (!token.empty() && token[0] == '#') {
      in.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
      continue;
    }
    return token;
  }
  throw std::runtime_error("unexpected end of PGM header");
}

GrayImage ReadPgm(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open PGM: " + path);
  const auto magic = NextToken(in);
  if (magic != "P5" && magic != "P2") throw std::runtime_error("only P5/P2 PGM is supported");
  GrayImage image;
  image.width = static_cast<std::uint32_t>(std::stoul(NextToken(in)));
  image.height = static_cast<std::uint32_t>(std::stoul(NextToken(in)));
  const auto maximum = std::stoul(NextToken(in));
  if (!image.width || !image.height || maximum == 0 || maximum > 255)
    throw std::runtime_error("unsupported PGM dimensions or max value");
  image.pixels.resize(static_cast<std::size_t>(image.width) * image.height);
  if (magic == "P5") {
    in.get();
    in.read(reinterpret_cast<char*>(image.pixels.data()), image.pixels.size());
    if (static_cast<std::size_t>(in.gcount()) != image.pixels.size())
      throw std::runtime_error("truncated PGM pixels");
  } else {
    for (auto& p : image.pixels)
      p = static_cast<std::uint8_t>(std::stoul(NextToken(in)) * 255U / maximum);
  }
  return image;
}

std::vector<std::uint8_t> BuildLikelihood(const std::vector<std::uint8_t>& occupancy,
                                           std::uint32_t width, std::uint32_t height) {
  constexpr float inf = 1.0e9F;
  std::vector<float> d(occupancy.size(), inf);
  for (std::size_t i = 0; i < occupancy.size(); ++i) if (occupancy[i] == 1) d[i] = 0.0F;
  const auto relax = [&](std::uint32_t x, std::uint32_t y, int dx, int dy, float cost) {
    const int nx = static_cast<int>(x) + dx, ny = static_cast<int>(y) + dy;
    if (nx < 0 || ny < 0 || nx >= static_cast<int>(width) || ny >= static_cast<int>(height)) return;
    auto& target = d[static_cast<std::size_t>(y) * width + x];
    target = std::min(target, d[static_cast<std::size_t>(ny) * width + nx] + cost);
  };
  for (std::uint32_t y = 0; y < height; ++y) for (std::uint32_t x = 0; x < width; ++x) {
    relax(x,y,-1,0,1); relax(x,y,0,-1,1); relax(x,y,-1,-1,1.4142F); relax(x,y,1,-1,1.4142F);
  }
  for (std::uint32_t y = height; y-- > 0;) for (std::uint32_t x = width; x-- > 0;) {
    relax(x,y,1,0,1); relax(x,y,0,1,1); relax(x,y,1,1,1.4142F); relax(x,y,-1,1,1.4142F);
  }
  std::vector<std::uint8_t> out(d.size());
  for (std::size_t i = 0; i < d.size(); ++i) {
    const float probability = std::exp(-0.5F * (d[i] * d[i]) / 4.0F);
    out[i] = static_cast<std::uint8_t>(std::lround(255.0F * probability));
    if (occupancy[i] == 2) out[i] = 0;
  }
  return out;
}

luckfox::MapLevel Downsample(const luckfox::MapLevel& source) {
  luckfox::MapLevel out;
  out.width = (source.width + 1U) / 2U;
  out.height = (source.height + 1U) / 2U;
  out.resolution = source.resolution * 2.0F;
  out.likelihood.assign(static_cast<std::size_t>(out.width) * out.height, 0);
  for (std::uint32_t y = 0; y < out.height; ++y) for (std::uint32_t x = 0; x < out.width; ++x) {
    std::uint8_t best = 0;
    for (std::uint32_t dy = 0; dy < 2; ++dy) for (std::uint32_t dx = 0; dx < 2; ++dx) {
      const auto sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx < source.width && sy < source.height)
        best = std::max(best, source.likelihood[static_cast<std::size_t>(sy) * source.width + sx]);
    }
    out.likelihood[static_cast<std::size_t>(y) * out.width + x] = best;
  }
  return out;
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc < 3 || argc > 4) {
    std::cerr << "Usage: map_converter MAP.yaml MAP.bin [pyramid-levels]\n";
    return 2;
  }
  const auto config = ParseYaml(argv[1]);
  fs::path image_path(config.image);
  if (image_path.is_relative()) image_path = fs::path(argv[1]).parent_path() / image_path;
  const auto image = ReadPgm(image_path.string());
  luckfox::SlamMap map;
  map.width = image.width; map.height = image.height; map.resolution = config.resolution;
  map.origin_x = config.origin_x; map.origin_y = config.origin_y; map.origin_yaw = config.origin_yaw;
  map.occupancy.resize(image.pixels.size());
  for (std::uint32_t y = 0; y < image.height; ++y) for (std::uint32_t x = 0; x < image.width; ++x) {
    const auto pgm = image.pixels[static_cast<std::size_t>(image.height - 1U - y) * image.width + x];
    const float occupied_probability = config.negate ? pgm / 255.0F : (255 - pgm) / 255.0F;
    auto value = std::uint8_t{2};
    // nav2_map_server uses gray 205 for unknown pixels in saved trinary PGM.
    // Preserve it explicitly; treating it only by probability thresholds can
    // incorrectly turn unexplored space into free space.
    if (config.mode == "trinary" && pgm == 205) value = 2;
    else if (occupied_probability > config.occupied_thresh) value = 1;
    else if (occupied_probability < config.free_thresh) value = 0;
    map.occupancy[static_cast<std::size_t>(y) * image.width + x] = value;
  }
  luckfox::MapLevel base{map.width, map.height, map.resolution,
    BuildLikelihood(map.occupancy, map.width, map.height)};
  const int requested = argc == 4 ? std::stoi(argv[3]) : 4;
  map.levels.push_back(std::move(base));
  while (static_cast<int>(map.levels.size()) < requested &&
         (map.levels.back().width > 1 || map.levels.back().height > 1))
    map.levels.push_back(Downsample(map.levels.back()));
  luckfox::SaveMap(map, argv[2]);
  std::cout << "Created " << argv[2] << ": " << map.width << "x" << map.height
            << ", resolution=" << map.resolution << " m, levels=" << map.levels.size() << '\n';
  return 0;
} catch (const std::exception& e) {
  std::cerr << "map_converter: " << e.what() << '\n';
  return 1;
}
