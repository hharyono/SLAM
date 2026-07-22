#include "luckfox/map.hpp"
#include "luckfox/robot_backend_client.hpp"
#include "luckfox/scan_tcp_client.hpp"
#include "luckfox/telemetry.hpp"
#include "luckfox/uart_localizer.hpp"

#include "CYdLidar.h"

#include <cstdlib>
#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <thread>
#include <stdexcept>

namespace {

float EnvironmentFloat(const char* name, float fallback) {
  const char* value = std::getenv(name);
  return value ? std::stof(value) : fallback;
}

unsigned EnvironmentUnsigned(const char* name, unsigned fallback) {
  const char* value = std::getenv(name);
  return value ? static_cast<unsigned>(std::stoul(value)) : fallback;
}

std::string EnvironmentString(const char* name, const char* fallback = "") {
  const char* value = std::getenv(name);
  return value ? value : fallback;
}

bool EnvironmentBool(const char* name, bool fallback) {
  const char* value = std::getenv(name);
  if (!value) return fallback;
  return std::string(value) != "0" && std::string(value) != "false";
}

void ValidateExperimentContext(const std::string& run_type,
                               const std::string& condition) {
  const bool supported_run_type =
      run_type == "runtime" || run_type == "ground_truth" ||
      run_type == "route" || run_type == "kidnapped" ||
      run_type == "dynamic_occluded" || run_type == "ablation" ||
      run_type == "resource";
  if (!supported_run_type)
    throw std::runtime_error("unsupported experiment run type: " + run_type);

  const bool supported_condition =
      condition == "nominal" || condition == "lidar_occluded_90" ||
      condition == "furniture_changed" || condition == "dynamic_occluded";
  if (!supported_condition)
    throw std::runtime_error("unsupported experiment condition: " + condition);

  if (run_type == "dynamic_occluded" && condition != "dynamic_occluded")
    throw std::runtime_error(
        "dynamic_occluded run type requires dynamic_occluded condition");
  if (run_type == "route" && condition == "dynamic_occluded")
    throw std::runtime_error(
        "dynamic_occluded condition requires the standalone run type");
  if (run_type != "runtime" && run_type != "route" &&
      run_type != "dynamic_occluded" && condition != "nominal")
    throw std::runtime_error(
        "this experiment run type requires nominal condition");
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc != 3 && argc != 4 && argc != 6 && argc != 7) {
    std::cerr << "Usage: localize_uart MAP.bin UART [BAUD]\n"
                 "       localize_uart MAP.bin UART INITIAL_X INITIAL_Y INITIAL_YAW [BAUD]\n"
                 "Example: localize_uart /etc/slam/ruang_utama.bin /dev/ttyS3 230400\n";
    return 2;
  }

  luckfox::UartLidarConfig config;
  config.port = argv[2];
  if (argc == 4) config.baudrate = std::stoi(argv[3]);
  if (argc == 7) config.baudrate = std::stoi(argv[6]);
  config.scan_frequency = EnvironmentFloat("LUCKFOX_SCAN_FREQUENCY_HZ", config.scan_frequency);
  config.minimum_range = EnvironmentFloat("LUCKFOX_MINIMUM_RANGE_M", config.minimum_range);
  config.maximum_range = EnvironmentFloat("LUCKFOX_MAXIMUM_RANGE_M", config.maximum_range);

  luckfox::SearchOptions search;
  search.linear_window = EnvironmentFloat("LUCKFOX_LINEAR_WINDOW_M", search.linear_window);
  search.angular_window = EnvironmentFloat("LUCKFOX_ANGULAR_WINDOW_RAD", search.angular_window);
  search.linear_step = EnvironmentFloat("LUCKFOX_LINEAR_STEP_M", search.linear_step);
  search.angular_step = EnvironmentFloat("LUCKFOX_ANGULAR_STEP_RAD", search.angular_step);
  search.minimum_score = EnvironmentFloat("LUCKFOX_MINIMUM_SCORE", search.minimum_score);
  search.use_multi_resolution = EnvironmentBool(
      "LUCKFOX_MULTI_RESOLUTION", search.use_multi_resolution);
  luckfox::StateOptions state;
  state.lost_after_rejections = EnvironmentUnsigned(
      "LUCKFOX_LOST_AFTER_REJECTIONS", state.lost_after_rejections);
  state.recovery_confirmations = EnvironmentUnsigned(
      "LUCKFOX_RECOVERY_CONFIRMATIONS", state.recovery_confirmations);
  state.enable_global_relocalization = EnvironmentBool(
      "LUCKFOX_ENABLE_GLOBAL_RELOCALIZATION", state.enable_global_relocalization);
  const luckfox::Pose2f initial{};

  luckfox::UartLocalizer localizer(luckfox::LoadMap(argv[1]), config, search, state);
  const std::string experiment_condition =
      EnvironmentString("LUCKFOX_EXPERIMENT_CONDITION", "nominal");
  const std::string experiment_run_type =
      EnvironmentString("LUCKFOX_EXPERIMENT_RUN_TYPE", "runtime");
  const std::string experiment_route_id =
      EnvironmentString("LUCKFOX_EXPERIMENT_ROUTE_ID", "runtime");
  ValidateExperimentContext(experiment_run_type, experiment_condition);
  luckfox::TelemetryLogger telemetry(
      EnvironmentString("LUCKFOX_TELEMETRY_LOG", "/tmp/localize_scans.jsonl"),
      EnvironmentString("LUCKFOX_RAW_SCAN_LOG"),
      EnvironmentString("LUCKFOX_EXPERIMENT_ID", "runtime"),
      experiment_condition, experiment_run_type, experiment_route_id);
  telemetry.LogConfiguration(config, search, state);
  std::unique_ptr<luckfox::RobotBackendClient> backend;
  std::unique_ptr<luckfox::ScanTcpClient> scan_stream;
  std::atomic<bool> mission_requested{true};
  if (const char* host = std::getenv("LUCKFOX_BACKEND_HOST")) {
    mission_requested = false;
    luckfox::RobotBackendConfig backend_config;
    backend_config.backend_host = host;
    if (const char* id = std::getenv("LUCKFOX_ROBOT_ID")) backend_config.robot_id = id;
    if (const char* port = std::getenv("LUCKFOX_BACKEND_PORT"))
      backend_config.backend_port = static_cast<std::uint16_t>(std::stoi(port));
    backend.reset(new luckfox::RobotBackendClient(std::move(backend_config)));
    backend->SetMissionCallback([&mission_requested](luckfox::MissionCommand command) {
      mission_requested = command == luckfox::MissionCommand::Start;
      std::cerr << "mission_command="
                << (command == luckfox::MissionCommand::Start ? "START" : "STOP") << '\n';
    });
    backend->SetMapInstalledCallback([&localizer](const std::string& path) {
      try {
        localizer.ReloadMap(luckfox::LoadMap(path));
        std::cerr << "map_reloaded=" << path << " next_mode=global\n";
        return true;
      } catch (const std::exception& error) {
        std::cerr << "map_reload_failed=" << error.what() << '\n';
        return false;
      }
    });
    backend->Start();

    luckfox::ScanTcpConfig scan_config;
    scan_config.host = std::getenv("LUCKFOX_SCAN_STREAM_HOST")
        ? std::getenv("LUCKFOX_SCAN_STREAM_HOST") : host;
    if (const char* port = std::getenv("LUCKFOX_SCAN_STREAM_PORT"))
      scan_config.port = static_cast<std::uint16_t>(std::stoi(port));
    scan_stream.reset(new luckfox::ScanTcpClient(std::move(scan_config)));
    scan_stream->Start();
  }

  std::uint64_t scan_sequence = 0;
  auto last_idle_resource_log = std::chrono::steady_clock::time_point{};
  while (ydlidar::os_isOk()) {
    if (!mission_requested) {
      if (localizer.IsRunning()) {
        localizer.Stop();
        if (backend) backend->UpdateMissionRunning(false);
        std::cerr << "lidar_state=STOPPED\n";
      }
      const auto now = std::chrono::steady_clock::now();
      if (last_idle_resource_log.time_since_epoch().count() == 0 ||
          now - last_idle_resource_log >= std::chrono::seconds(1)) {
        telemetry.LogResource("idle");
        last_idle_resource_log = now;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }

    if (!localizer.IsRunning()) {
      localizer.Start();
      if (backend) backend->UpdateMissionRunning(true);
      std::cerr << "lidar_state=RUNNING\n";
    }

    luckfox::CapturedScan scan;
    const auto cycle_started = std::chrono::steady_clock::now();
    const auto result = localizer.LocalizeNext(initial, &scan);
    const auto scan_cycle_us = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - cycle_started).count());
    telemetry.Log(++scan_sequence, scan, result, scan_cycle_us);
    if (scan_stream) scan_stream->UpdateScan(scan);
    if (backend) backend->UpdatePose(result);
    std::cout << "x=" << result.pose.x << " y=" << result.pose.y
              << " yaw=" << result.pose.yaw << " score=" << result.score
              << " valid=" << (result.valid ? 1 : 0)
              << " mode=" << (result.global_search ? "global" : "tracking")
              << " state=" << luckfox::LocalizationStateName(result.state)
              << " evaluated=" << result.evaluated
              << " execution_us=" << result.execution_time_us
              << " reason=" << result.transition_reason << '\n';
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << "localize_uart: " << error.what() << '\n';
  return 1;
}
