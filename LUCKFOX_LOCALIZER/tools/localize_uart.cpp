#include "luckfox/map.hpp"
#include "luckfox/robot_backend_client.hpp"
#include "luckfox/scan_tcp_client.hpp"
#include "luckfox/uart_localizer.hpp"

#include "CYdLidar.h"

#include <cstdlib>
#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <thread>
#include <stdexcept>

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
  const luckfox::Pose2f initial{};

  luckfox::UartLocalizer localizer(luckfox::LoadMap(argv[1]), config);
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
    if (const char* power = std::getenv("LUCKFOX_POWER_PERCENT"))
      backend->UpdatePower(std::stof(power));
    backend->Start();

    luckfox::ScanTcpConfig scan_config;
    scan_config.host = std::getenv("LUCKFOX_SCAN_STREAM_HOST")
        ? std::getenv("LUCKFOX_SCAN_STREAM_HOST") : host;
    if (const char* port = std::getenv("LUCKFOX_SCAN_STREAM_PORT"))
      scan_config.port = static_cast<std::uint16_t>(std::stoi(port));
    scan_stream.reset(new luckfox::ScanTcpClient(std::move(scan_config)));
    scan_stream->Start();
  }

  while (ydlidar::os_isOk()) {
    if (!mission_requested) {
      if (localizer.IsRunning()) {
        localizer.Stop();
        if (backend) backend->UpdateMissionRunning(false);
        std::cerr << "lidar_state=STOPPED\n";
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
    const auto result = localizer.LocalizeNext(initial, scan_stream ? &scan : nullptr);
    if (scan_stream) scan_stream->UpdateScan(scan);
    if (backend) backend->UpdatePose(result);
    std::cout << "x=" << result.pose.x << " y=" << result.pose.y
              << " yaw=" << result.pose.yaw << " score=" << result.score
              << " valid=" << (result.valid ? 1 : 0)
              << " mode=" << (result.global_search ? "global" : "tracking")
              << " evaluated=" << result.evaluated << '\n';
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << "localize_uart: " << error.what() << '\n';
  return 1;
}
