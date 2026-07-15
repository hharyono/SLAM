cmake_minimum_required(VERSION 3.8)
project(scan_tcp_bridge)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -Wpedantic)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(nav_msgs REQUIRED)

add_executable(scan_tcp_bridge_node src/scan_tcp_bridge_node.cpp)
ament_target_dependencies(scan_tcp_bridge_node rclcpp sensor_msgs nav_msgs)
install(TARGETS scan_tcp_bridge_node DESTINATION lib/${PROJECT_NAME})
ament_package()
