#include "luckfox/map.hpp"
#include "luckfox/uart_localizer.hpp"

#include "CYdLidar.h"

#include <cstdlib>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) try {
  if (argc != 6 && argc != 7) {
    std::cerr << "Usage: localize_uart MAP.bin UART INITIAL_X INITIAL_Y INITIAL_YAW [BAUD]\n"
                 "Example: localize_uart /etc/slam/ruang_utama.bin /dev/ttyUSB0 0 0 0 230400\n";
    return 2;
  }

  luckfox::UartLidarConfig config;
  config.port = argv[2];
  if (argc == 7) config.baudrate = std::stoi(argv[6]);
  const luckfox::Pose2f initial{std::stof(argv[3]), std::stof(argv[4]),
                                std::stof(argv[5])};

  luckfox::UartLocalizer localizer(luckfox::LoadMap(argv[1]), config);
  localizer.Start();
  while (ydlidar::os_isOk()) {
    const auto result = localizer.LocalizeNext(initial);
    std::cout << "x=" << result.pose.x << " y=" << result.pose.y
              << " yaw=" << result.pose.yaw << " score=" << result.score
              << " valid=" << (result.valid ? 1 : 0)
              << " evaluated=" << result.evaluated << '\n';
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << "localize_uart: " << error.what() << '\n';
  return 1;
}
