#include "luckfox/map.hpp"

#include <array>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <type_traits>

namespace luckfox {
namespace {

constexpr std::array<char, 8> kMagic{{'S','L','A','M','M','A','P','\0'}};

template <typename T>
void Append(std::vector<std::uint8_t>& out, const T value) {
  static_assert(std::is_trivially_copyable<T>::value, "binary scalar required");
  const auto* p = reinterpret_cast<const std::uint8_t*>(&value);
  out.insert(out.end(), p, p + sizeof(T));
}

template <typename T>
T Read(const std::vector<std::uint8_t>& in, std::size_t& offset) {
  if (offset + sizeof(T) > in.size()) throw std::runtime_error("truncated map.bin");
  T value{};
  std::memcpy(&value, in.data() + offset, sizeof(T));
  offset += sizeof(T);
  return value;
}

void CheckMap(const SlamMap& map) {
  if (!map.width || !map.height || map.resolution <= 0.0F)
    throw std::runtime_error("invalid map dimensions or resolution");
  if (map.occupancy.size() != static_cast<std::size_t>(map.width) * map.height)
    throw std::runtime_error("occupancy size does not match dimensions");
  for (const auto& level : map.levels)
    if (level.likelihood.size() != static_cast<std::size_t>(level.width) * level.height)
      throw std::runtime_error("pyramid level size does not match dimensions");
}

}  // namespace

void SaveMap(const SlamMap& map, const std::string& path) {
  CheckMap(map);
  std::vector<std::uint8_t> body;
  body.insert(body.end(), kMagic.begin(), kMagic.end());
  Append(body, kMapVersion);
  Append(body, map.width); Append(body, map.height); Append(body, map.resolution);
  Append(body, map.origin_x); Append(body, map.origin_y); Append(body, map.origin_yaw);
  Append(body, static_cast<std::uint32_t>(map.levels.size()));
  Append(body, static_cast<std::uint32_t>(map.occupancy.size()));
  body.insert(body.end(), map.occupancy.begin(), map.occupancy.end());
  for (const auto& level : map.levels) {
    Append(body, level.width); Append(body, level.height); Append(body, level.resolution);
    Append(body, static_cast<std::uint32_t>(level.likelihood.size()));
    body.insert(body.end(), level.likelihood.begin(), level.likelihood.end());
  }
  const auto crc = Crc32(body.data(), body.size());
  Append(body, crc);
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("cannot create " + path);
  out.write(reinterpret_cast<const char*>(body.data()), static_cast<std::streamsize>(body.size()));
  if (!out) throw std::runtime_error("failed writing " + path);
}

SlamMap LoadMap(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open " + path);
  std::vector<std::uint8_t> data((std::istreambuf_iterator<char>(in)), {});
  if (data.size() < kMagic.size() + sizeof(std::uint32_t) * 2)
    throw std::runtime_error("map.bin is too small");
  std::uint32_t stored_crc{};
  std::memcpy(&stored_crc, data.data() + data.size() - sizeof(stored_crc), sizeof(stored_crc));
  const auto actual_crc = Crc32(data.data(), data.size() - sizeof(stored_crc));
  if (actual_crc != stored_crc) throw std::runtime_error("map.bin CRC mismatch");
  std::size_t offset = 0;
  if (!std::equal(kMagic.begin(), kMagic.end(), data.begin()))
    throw std::runtime_error("invalid map.bin magic");
  offset += kMagic.size();
  if (Read<std::uint32_t>(data, offset) != kMapVersion)
    throw std::runtime_error("unsupported map.bin version");
  SlamMap map;
  map.width = Read<std::uint32_t>(data, offset);
  map.height = Read<std::uint32_t>(data, offset);
  map.resolution = Read<float>(data, offset);
  map.origin_x = Read<float>(data, offset);
  map.origin_y = Read<float>(data, offset);
  map.origin_yaw = Read<float>(data, offset);
  const auto level_count = Read<std::uint32_t>(data, offset);
  const auto occupancy_size = Read<std::uint32_t>(data, offset);
  if (offset + occupancy_size > data.size() - sizeof(stored_crc))
    throw std::runtime_error("truncated occupancy data");
  map.occupancy.assign(data.begin() + offset, data.begin() + offset + occupancy_size);
  offset += occupancy_size;
  for (std::uint32_t i = 0; i < level_count; ++i) {
    MapLevel level;
    level.width = Read<std::uint32_t>(data, offset);
    level.height = Read<std::uint32_t>(data, offset);
    level.resolution = Read<float>(data, offset);
    const auto size = Read<std::uint32_t>(data, offset);
    if (offset + size > data.size() - sizeof(stored_crc))
      throw std::runtime_error("truncated pyramid data");
    level.likelihood.assign(data.begin() + offset, data.begin() + offset + size);
    offset += size;
    map.levels.push_back(std::move(level));
  }
  if (offset != data.size() - sizeof(stored_crc))
    throw std::runtime_error("unexpected data at end of map.bin");
  CheckMap(map);
  return map;
}

}  // namespace luckfox
