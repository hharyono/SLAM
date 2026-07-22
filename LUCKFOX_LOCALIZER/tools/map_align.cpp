#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace {

constexpr double kPi = 3.14159265358979323846;

struct Config {
  std::string image;
  double resolution = 0.0;
  double occupied_threshold = 0.65;
  bool negate = false;
};

struct GrayImage {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> pixels;
};

struct PixelPoint {
  int x = 0;
  int y = 0;
};

struct Direction {
  double image_angle = 0.0;
  int votes = 0;
  int rho = 0;
};

std::string Trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string Unquote(std::string value) {
  value = Trim(std::move(value));
  if (value.size() >= 2 &&
      ((value.front() == '\'' && value.back() == '\'') ||
       (value.front() == '"' && value.back() == '"'))) {
    return value.substr(1, value.size() - 2);
  }
  return value;
}

Config ParseYaml(const fs::path& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot open YAML: " + path.string());
  Config config;
  std::string line;
  while (std::getline(input, line)) {
    const auto comment = line.find('#');
    if (comment != std::string::npos) line.erase(comment);
    const auto colon = line.find(':');
    if (colon == std::string::npos) continue;
    const auto key = Trim(line.substr(0, colon));
    const auto value = Unquote(line.substr(colon + 1));
    if (key == "image") config.image = value;
    else if (key == "resolution") config.resolution = std::stod(value);
    else if (key == "occupied_thresh") config.occupied_threshold = std::stod(value);
    else if (key == "negate") config.negate = std::stoi(value) != 0;
  }
  if (config.image.empty() || config.resolution <= 0.0) {
    throw std::runtime_error("YAML requires image and positive resolution");
  }
  return config;
}

std::string NextToken(std::istream& input) {
  std::string token;
  while (input >> token) {
    if (!token.empty() && token.front() == '#') {
      input.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
      continue;
    }
    return token;
  }
  throw std::runtime_error("unexpected end of PGM header");
}

GrayImage ReadPgm(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("cannot open PGM: " + path.string());
  const auto magic = NextToken(input);
  if (magic != "P5" && magic != "P2") {
    throw std::runtime_error("only P5/P2 PGM is supported");
  }
  GrayImage image;
  image.width = static_cast<std::uint32_t>(std::stoul(NextToken(input)));
  image.height = static_cast<std::uint32_t>(std::stoul(NextToken(input)));
  const auto maximum = std::stoul(NextToken(input));
  if (!image.width || !image.height || maximum == 0 || maximum > 255) {
    throw std::runtime_error("unsupported PGM dimensions or max value");
  }
  image.pixels.resize(static_cast<std::size_t>(image.width) * image.height);
  if (magic == "P5") {
    input.get();
    input.read(reinterpret_cast<char*>(image.pixels.data()),
               static_cast<std::streamsize>(image.pixels.size()));
    if (static_cast<std::size_t>(input.gcount()) != image.pixels.size()) {
      throw std::runtime_error("truncated PGM pixels");
    }
  } else {
    for (auto& pixel : image.pixels) {
      pixel = static_cast<std::uint8_t>(std::stoul(NextToken(input)) * 255U / maximum);
    }
  }
  return image;
}

std::vector<PixelPoint> OccupiedPixels(const GrayImage& image, const Config& config) {
  std::vector<PixelPoint> points;
  points.reserve(image.pixels.size() / 8U);
  for (std::uint32_t y = 0; y < image.height; ++y) {
    for (std::uint32_t x = 0; x < image.width; ++x) {
      const auto gray = image.pixels[static_cast<std::size_t>(y) * image.width + x];
      const double occupied_probability =
          config.negate ? gray / 255.0 : (255.0 - gray) / 255.0;
      if (occupied_probability > config.occupied_threshold) {
        points.push_back({static_cast<int>(x), static_cast<int>(y)});
      }
    }
  }
  if (points.size() < 8) throw std::runtime_error("not enough occupied pixels to align map");
  return points;
}

Direction EvaluateDirection(const std::vector<PixelPoint>& points, double image_angle,
                            int diagonal, std::vector<int>& accumulator) {
  std::fill(accumulator.begin(), accumulator.end(), 0);
  const double normal_x = -std::sin(image_angle);
  const double normal_y = std::cos(image_angle);
  Direction result{image_angle, 0, 0};
  for (const auto& point : points) {
    const int rho = static_cast<int>(
        std::lround(normal_x * static_cast<double>(point.x) +
                    normal_y * static_cast<double>(point.y)));
    const int index = rho + diagonal;
    if (index < 0 || index >= static_cast<int>(accumulator.size())) continue;
    const int votes = ++accumulator[static_cast<std::size_t>(index)];
    if (votes > result.votes) {
      result.votes = votes;
      result.rho = rho;
    }
  }
  return result;
}

Direction DetectDominantWall(const GrayImage& image,
                             const std::vector<PixelPoint>& occupied) {
  const int diagonal = static_cast<int>(
      std::ceil(std::hypot(static_cast<double>(image.width),
                           static_cast<double>(image.height))));
  std::vector<int> accumulator(static_cast<std::size_t>(2 * diagonal + 1));
  Direction best;

  constexpr double coarse_step = 0.5 * kPi / 180.0;
  for (double angle = 0.0; angle < kPi; angle += coarse_step) {
    const auto candidate = EvaluateDirection(occupied, angle, diagonal, accumulator);
    if (candidate.votes > best.votes) best = candidate;
  }

  const double coarse_angle = best.image_angle;
  constexpr double fine_step = 0.01 * kPi / 180.0;
  for (double angle = coarse_angle - coarse_step; angle <= coarse_angle + coarse_step;
       angle += fine_step) {
    const auto candidate = EvaluateDirection(occupied, angle, diagonal, accumulator);
    if (candidate.votes > best.votes) best = candidate;
  }
  if (best.votes < 8) throw std::runtime_error("no reliable wall direction detected");
  return best;
}

void WriteAlignedYaml(const fs::path& yaml_path, double origin_x, double origin_y,
                      double origin_yaw) {
  std::ifstream input(yaml_path);
  if (!input) throw std::runtime_error("cannot reopen YAML: " + yaml_path.string());
  std::ostringstream output;
  std::string line;
  bool replaced = false;
  while (std::getline(input, line)) {
    const auto colon = line.find(':');
    if (colon != std::string::npos && Trim(line.substr(0, colon)) == "origin") {
      output << "origin: [" << std::fixed << std::setprecision(9) << origin_x << ", "
             << origin_y << ", " << origin_yaw << "]\n";
      replaced = true;
    } else {
      output << line << '\n';
    }
  }
  if (!replaced) {
    output << "origin: [" << std::fixed << std::setprecision(9) << origin_x << ", "
           << origin_y << ", " << origin_yaw << "]\n";
  }

  const fs::path temporary = yaml_path.string() + ".aligning";
  {
    std::ofstream file(temporary, std::ios::trunc);
    if (!file) throw std::runtime_error("cannot write temporary YAML: " + temporary.string());
    file << output.str();
    if (!file) throw std::runtime_error("failed writing temporary YAML: " + temporary.string());
  }
  fs::rename(temporary, yaml_path);
}

void WriteAlignmentReport(const fs::path& yaml_path, const GrayImage& image,
                          const Direction& direction, double wall_angle, double origin_x,
                          double origin_y, double origin_yaw, double resolution) {
  fs::path report_path = yaml_path;
  report_path.replace_extension(".alignment.json");
  std::ofstream report(report_path, std::ios::trunc);
  if (!report) throw std::runtime_error("cannot write alignment report: " + report_path.string());
  report << std::fixed << std::setprecision(9)
         << "{\n"
         << "  \"method\": \"occupied-pixel-hough-dominant-wall\",\n"
         << "  \"image_width_px\": " << image.width << ",\n"
         << "  \"image_height_px\": " << image.height << ",\n"
         << "  \"resolution_m_per_px\": " << resolution << ",\n"
         << "  \"detected_wall_angle_deg\": " << wall_angle * 180.0 / kPi << ",\n"
         << "  \"hough_votes\": " << direction.votes << ",\n"
         << "  \"origin_x_m\": " << origin_x << ",\n"
         << "  \"origin_y_m\": " << origin_y << ",\n"
         << "  \"origin_yaw_rad\": " << origin_yaw << "\n"
         << "}\n";
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc != 2) {
    std::cerr << "Usage: map_align MAP.yaml\n";
    return 2;
  }
  const fs::path yaml_path = argv[1];
  const auto config = ParseYaml(yaml_path);
  fs::path image_path = config.image;
  if (image_path.is_relative()) image_path = yaml_path.parent_path() / image_path;
  const auto image = ReadPgm(image_path);
  const auto occupied = OccupiedPixels(image, config);
  const auto direction = DetectDominantWall(image, occupied);

  // PGM Y grows downward; the map/world Y axis grows upward. Canonicalize the
  // undirected wall angle to [-90, +90] degrees, then cancel it with map yaw.
  const double wall_angle = std::remainder(-direction.image_angle, kPi);
  const double origin_yaw = -wall_angle;
  const double width_m = image.width * config.resolution;
  const double height_m = image.height * config.resolution;
  const double cosine = std::cos(origin_yaw);
  const double sine = std::sin(origin_yaw);
  const std::vector<std::pair<double, double>> corners = {
      {0.0, 0.0}, {width_m, 0.0}, {width_m, height_m}, {0.0, height_m}};
  double minimum_x = std::numeric_limits<double>::infinity();
  double minimum_y = std::numeric_limits<double>::infinity();
  for (const auto& [x, y] : corners) {
    minimum_x = std::min(minimum_x, cosine * x - sine * y);
    minimum_y = std::min(minimum_y, sine * x + cosine * y);
  }
  const auto without_negative_zero = [](double value) {
    return std::abs(value) < 1.0e-12 ? 0.0 : value;
  };
  const double origin_x = without_negative_zero(-minimum_x);
  const double origin_y = without_negative_zero(-minimum_y);

  WriteAlignedYaml(yaml_path, origin_x, origin_y, origin_yaw);
  WriteAlignmentReport(yaml_path, image, direction, wall_angle, origin_x, origin_y,
                       origin_yaw, config.resolution);
  std::cout << std::fixed << std::setprecision(3)
            << "Aligned " << yaml_path << ": wall=" << wall_angle * 180.0 / kPi
            << " deg, yaw=" << origin_yaw * 180.0 / kPi << " deg, origin=("
            << origin_x << ", " << origin_y << ") m, votes=" << direction.votes << '\n';
  return 0;
} catch (const std::exception& error) {
  std::cerr << "map_align: " << error.what() << '\n';
  return 1;
}
