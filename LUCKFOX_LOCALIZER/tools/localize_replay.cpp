#include "luckfox/localizer.hpp"
#include "luckfox/map.hpp"

#include <chrono>
#include <ext/stdio_filebuf.h>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <unistd.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

const char* ExecutionTarget() {
  const char* configured = std::getenv("LUCKFOX_EXECUTION_TARGET");
  if (configured && (std::string(configured) == "host" ||
                     std::string(configured) == "rv1103" ||
                     std::string(configured) == "rv1106"))
    return configured;
#if defined(__arm__) || defined(__aarch64__)
  return "rv";
#else
  return "host";
#endif
}

std::uint64_t TimevalUs(const timeval& value) {
  return static_cast<std::uint64_t>(value.tv_sec) * 1000000ULL +
         static_cast<std::uint64_t>(value.tv_usec);
}

std::uint64_t CurrentRssKb() {
  std::ifstream input("/proc/self/statm");
  std::uint64_t total_pages = 0, resident_pages = 0;
  if (!(input >> total_pages >> resident_pages)) return 0;
  (void)total_pages;
  return resident_pages * static_cast<std::uint64_t>(sysconf(_SC_PAGESIZE)) /
         1024ULL;
}

float EnvironmentFloat(const char* name, float fallback) {
  const char* value = std::getenv(name);
  return value ? std::stof(value) : fallback;
}

unsigned EnvironmentUnsigned(const char* name, unsigned fallback) {
  const char* value = std::getenv(name);
  return value ? static_cast<unsigned>(std::stoul(value)) : fallback;
}

std::string ReplayPacing() {
  const char* configured = std::getenv("LUCKFOX_REPLAY_PACING");
  const std::string pacing = configured ? configured : "unpaced";
  if (pacing != "unpaced" && pacing != "recorded")
    throw std::runtime_error("LUCKFOX_REPLAY_PACING must be unpaced or recorded");
  return pacing;
}

class ReplayPacer {
 public:
  explicit ReplayPacer(std::string mode) : mode_(std::move(mode)) {}

  std::uint64_t Wait(std::uint64_t timestamp_ns) {
    if (mode_ != "recorded") return 0;
    if (!initialized_) {
      initialized_ = true;
      first_timestamp_ns_ = timestamp_ns;
      started_ = std::chrono::steady_clock::now();
      return 0;
    }
    if (timestamp_ns < first_timestamp_ns_)
      throw std::runtime_error("recorded replay timestamp moved backwards");
    const auto wait_before = std::chrono::steady_clock::now();
    std::this_thread::sleep_until(
        started_ + std::chrono::nanoseconds(timestamp_ns - first_timestamp_ns_));
    const auto wait_after = std::chrono::steady_clock::now();
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(wait_after -
                                                              wait_before)
            .count());
  }

 private:
  std::string mode_;
  bool initialized_ = false;
  std::uint64_t first_timestamp_ns_ = 0;
  std::chrono::steady_clock::time_point started_{};
};

struct ReplayResourceState {
  bool initialized = false;
  std::uint64_t previous_cpu_us = 0;
  std::chrono::steady_clock::time_point previous_wall{};
};

struct ScanGroup {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_ns = 0;
  std::uint32_t raw_points = 0;
  std::vector<luckfox::Point2f> points;
};

void Emit(const luckfox::SlamMap& map, luckfox::PoseTracker* tracker,
          const ScanGroup& scan, const std::string& variant,
          bool global_relocalization, bool multi_resolution,
          const std::string& replay_pacing, ReplayPacer* pacer,
          ReplayResourceState* resource_state,
          std::ostream& output) {
  if (scan.raw_points == 0) return;
  const auto pacing_wait_us = pacer->Wait(scan.timestamp_ns);
  rusage usage_before{};
  getrusage(RUSAGE_SELF, &usage_before);
  const auto wall_before = std::chrono::steady_clock::now();
  auto result = tracker->Update(map, scan.points);
  const auto wall_after = std::chrono::steady_clock::now();
  rusage usage_after{};
  getrusage(RUSAGE_SELF, &usage_after);
  const auto cpu_before = TimevalUs(usage_before.ru_utime) +
                          TimevalUs(usage_before.ru_stime);
  const auto cpu_after =
      TimevalUs(usage_after.ru_utime) + TimevalUs(usage_after.ru_stime);
  const auto wall_us =
      std::chrono::duration_cast<std::chrono::microseconds>(wall_after -
                                                            wall_before)
          .count();
  const auto cpu_delta_us = cpu_after - cpu_before;
  const double matcher_cpu_percent =
      wall_us > 0 ? 100.0 * static_cast<double>(cpu_delta_us) /
                        static_cast<double>(wall_us)
                  : 0.0;
  const auto interval_wall_us = resource_state->initialized
                                    ? std::chrono::duration_cast<std::chrono::microseconds>(
                                          wall_after - resource_state->previous_wall)
                                          .count()
                                    : wall_us;
  const auto interval_cpu_us =
      resource_state->initialized ? cpu_after - resource_state->previous_cpu_us
                                  : cpu_delta_us;
  const double interval_cpu_percent =
      interval_wall_us > 0
          ? 100.0 * static_cast<double>(interval_cpu_us) /
                static_cast<double>(interval_wall_us)
          : 0.0;
  resource_state->initialized = true;
  resource_state->previous_cpu_us = cpu_after;
  resource_state->previous_wall = wall_after;
  output << std::setprecision(9)
            << "{\"schema\":\"luckfox.localization.replay.v1\""
            << ",\"variant\":\"" << variant << "\""
            << ",\"global_relocalization\":"
            << (global_relocalization ? "true" : "false")
            << ",\"multi_resolution\":"
            << (multi_resolution ? "true" : "false")
            << ",\"execution_target\":\"" << ExecutionTarget() << "\""
            << ",\"replay_pacing\":\"" << replay_pacing << "\""
            << ",\"sequence\":" << scan.sequence
            << ",\"timestamp_unix_ms\":" << scan.timestamp_ns / 1000000ULL
            << ",\"scan_timestamp_ns\":" << scan.timestamp_ns
            << ",\"x_m\":" << result.pose.x
            << ",\"y_m\":" << result.pose.y
            << ",\"yaw_rad\":" << result.pose.yaw
            << ",\"score\":" << result.score
            << ",\"mode\":\"" << (result.global_search ? "global" : "tracking") << "\""
            << ",\"state\":\"" << luckfox::LocalizationStateName(result.state) << "\""
            << ",\"previous_state\":\""
            << luckfox::LocalizationStateName(result.previous_state) << "\""
            << ",\"accepted\":" << (result.valid ? "true" : "false")
            << ",\"candidate_count\":" << result.evaluated
            << ",\"valid_scan_points\":" << result.valid_scan_points
            << ",\"raw_scan_points\":" << scan.raw_points
            << ",\"matcher_execution_us\":" << result.execution_time_us
            << ",\"scan_cycle_us\":" << wall_us
            << ",\"process_cpu_time_us\":" << cpu_after
            << ",\"process_cpu_delta_us\":" << cpu_delta_us
            << ",\"process_cpu_percent\":" << matcher_cpu_percent
            << ",\"process_cpu_interval_delta_us\":" << interval_cpu_us
            << ",\"replay_interval_us\":" << interval_wall_us
            << ",\"process_cpu_interval_percent\":" << interval_cpu_percent
            << ",\"pacing_wait_us\":" << pacing_wait_us
            << ",\"rss_kb\":" << CurrentRssKb()
            << ",\"peak_rss_kb\":" << usage_after.ru_maxrss
            << ",\"transition_reason\":\"" << result.transition_reason << "\""
            << ",\"consecutive_rejections\":" << result.consecutive_rejections
            << ",\"recovery_confirmations\":" << result.recovery_confirmations
            << "}\n";
  output.flush();
}

int AcceptReplayStream(const std::string& input_name) {
  constexpr const char* prefix = "tcp-listen:";
  const int port = std::stoi(input_name.substr(std::char_traits<char>::length(prefix)));
  if (port < 1024 || port > 65535) throw std::runtime_error("invalid replay TCP port");
  const int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) throw std::runtime_error("cannot create replay TCP socket");
  int reuse = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(static_cast<std::uint16_t>(port));
  if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      listen(listener, 1) != 0) {
    close(listener);
    throw std::runtime_error("cannot listen for replay TCP stream");
  }
  const int client = accept(listener, nullptr, nullptr);
  close(listener);
  if (client < 0) throw std::runtime_error("cannot accept replay TCP stream");
  return client;
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc != 3 && argc != 5 && argc != 9) {
    std::cerr << "Usage: localize_replay MAP.bin raw_scans.csv "
                 "[--mode local_only_single|local_only_multi|"
                 "local_global_single|local_global_multi "
                 "[--initial X Y YAW]] "
                 "> replay.jsonl\n";
    return 2;
  }
  const std::string variant = argc >= 5 ? argv[4] : "local_global_multi";
  if (argc == 5 && std::string(argv[3]) != "--mode")
    throw std::runtime_error("expected --mode before replay variant");
  if (argc == 9 && (std::string(argv[3]) != "--mode" ||
                    std::string(argv[5]) != "--initial"))
    throw std::runtime_error("expected --mode VARIANT --initial X Y YAW");
  if (variant != "local_only_single" && variant != "local_only_multi" &&
      variant != "local_global_single" && variant != "local_global_multi")
    throw std::runtime_error("invalid replay variant: " + variant);
  const std::string execution_target = ExecutionTarget();
  if ((execution_target == "rv1103" || execution_target == "rv1106") &&
      variant != "local_global_multi")
    throw std::runtime_error(
        "board replay validates only the selected local_global_multi method");
  const bool global_relocalization =
      variant == "local_global_single" || variant == "local_global_multi";
  const bool multi_resolution =
      variant == "local_only_multi" || variant == "local_global_multi";
  const std::string replay_pacing = ReplayPacing();
  ReplayPacer pacer(replay_pacing);
  ReplayResourceState resource_state;
  const auto map = luckfox::LoadMap(argv[1]);
  luckfox::SearchOptions search;
  search.linear_window = EnvironmentFloat("LUCKFOX_LINEAR_WINDOW_M", search.linear_window);
  search.angular_window = EnvironmentFloat("LUCKFOX_ANGULAR_WINDOW_RAD", search.angular_window);
  search.linear_step = EnvironmentFloat("LUCKFOX_LINEAR_STEP_M", search.linear_step);
  search.angular_step = EnvironmentFloat("LUCKFOX_ANGULAR_STEP_RAD", search.angular_step);
  search.minimum_score = EnvironmentFloat("LUCKFOX_MINIMUM_SCORE", search.minimum_score);
  search.use_multi_resolution = multi_resolution;
  luckfox::StateOptions state;
  state.lost_after_rejections = EnvironmentUnsigned(
      "LUCKFOX_LOST_AFTER_REJECTIONS", state.lost_after_rejections);
  state.recovery_confirmations = EnvironmentUnsigned(
      "LUCKFOX_RECOVERY_CONFIRMATIONS", state.recovery_confirmations);
  state.enable_global_relocalization = global_relocalization;
  luckfox::PoseTracker tracker(search, state);
  if (argc == 9)
    tracker.Initialize(
        {std::stof(argv[6]), std::stof(argv[7]), std::stof(argv[8])});
  const float minimum_range = EnvironmentFloat("LUCKFOX_MINIMUM_RANGE_M", 0.05F);
  const float maximum_range = EnvironmentFloat("LUCKFOX_MAXIMUM_RANGE_M", 12.0F);

  const std::string input_name = argv[2];
  std::ifstream file_input;
  std::unique_ptr<__gnu_cxx::stdio_filebuf<char>> socket_input_buffer;
  std::unique_ptr<__gnu_cxx::stdio_filebuf<char>> socket_output_buffer;
  std::unique_ptr<std::istream> socket_input;
  std::unique_ptr<std::ostream> socket_output;
  std::istream* input = nullptr;
  std::ostream* output = &std::cout;
  if (input_name.rfind("tcp-listen:", 0) == 0) {
    const int client = AcceptReplayStream(input_name);
    const int output_fd = dup(client);
    if (output_fd < 0) {
      close(client);
      throw std::runtime_error("cannot duplicate replay TCP stream");
    }
    socket_input_buffer = std::make_unique<__gnu_cxx::stdio_filebuf<char>>(
        client, std::ios::in);
    socket_output_buffer = std::make_unique<__gnu_cxx::stdio_filebuf<char>>(
        output_fd, std::ios::out);
    socket_input = std::make_unique<std::istream>(socket_input_buffer.get());
    socket_output = std::make_unique<std::ostream>(socket_output_buffer.get());
    input = socket_input.get();
    output = socket_output.get();
  } else {
    file_input.open(input_name);
    if (!file_input)
      throw std::runtime_error(std::string("cannot open ") + input_name);
    input = &file_input;
  }
  std::string line;
  std::getline(*input, line);  // CSV header.
  ScanGroup group;
  std::uint64_t previous_sequence = 0;
  std::uint64_t previous_timestamp_ns = 0;
  while (std::getline(*input, line)) {
    if (line.empty()) continue;
    for (char& character : line) if (character == ',') character = ' ';
    std::istringstream row(line);
    std::uint64_t sequence = 0, timestamp_ns = 0;
    float angle = 0.0F, range = 0.0F, intensity = 0.0F;
    if (!(row >> sequence >> timestamp_ns >> angle >> range >> intensity))
      throw std::runtime_error("invalid raw scan CSV row");
    (void)intensity;
    if (group.raw_points && sequence != group.sequence) {
      if (sequence <= group.sequence)
        throw std::runtime_error("raw scan sequence is not strictly increasing");
      if (timestamp_ns < group.timestamp_ns)
        throw std::runtime_error("raw scan timestamp moved backwards");
      Emit(map, &tracker, group, variant, global_relocalization,
           multi_resolution, replay_pacing, &pacer, &resource_state, *output);
      previous_sequence = group.sequence;
      previous_timestamp_ns = group.timestamp_ns;
      group = {};
    }
    if ((previous_sequence && sequence <= previous_sequence) ||
        (previous_timestamp_ns && timestamp_ns < previous_timestamp_ns))
      throw std::runtime_error("raw scan ordering is invalid");
    if (group.raw_points && timestamp_ns != group.timestamp_ns)
      throw std::runtime_error("one scan sequence contains multiple timestamps");
    group.sequence = sequence;
    group.timestamp_ns = timestamp_ns;
    ++group.raw_points;
    if (std::isfinite(angle) && std::isfinite(range) &&
        range >= minimum_range && range <= maximum_range)
      group.points.push_back({range * std::cos(angle), range * std::sin(angle)});
  }
  Emit(map, &tracker, group, variant, global_relocalization,
       multi_resolution, replay_pacing, &pacer, &resource_state, *output);
  return 0;
} catch (const std::exception& error) {
  std::cerr << "localize_replay: " << error.what() << '\n';
  return 1;
}
