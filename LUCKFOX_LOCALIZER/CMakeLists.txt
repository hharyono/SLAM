cmake_minimum_required(VERSION 3.16)
project(luckfox_localizer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(slam_map
    src/crc32.cpp
    src/map_io.cpp
    src/localizer.cpp)
target_include_directories(slam_map PUBLIC include)
target_compile_options(slam_map PRIVATE -Wall -Wextra -Wpedantic)

add_executable(map_converter tools/map_converter.cpp)
target_link_libraries(map_converter PRIVATE slam_map)

add_executable(map_inspect tools/map_inspect.cpp)
target_link_libraries(map_inspect PRIVATE slam_map)

add_executable(localize_scan tools/localize_scan.cpp)
target_link_libraries(localize_scan PRIVATE slam_map)

include(CTest)
if(BUILD_TESTING)
  add_executable(map_tests tests/map_tests.cpp)
  target_link_libraries(map_tests PRIVATE slam_map)
  add_test(NAME map_tests COMMAND map_tests)
  add_test(NAME converter_test
    COMMAND map_converter
      ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/tiny.yaml
      ${CMAKE_CURRENT_BINARY_DIR}/tiny.bin)
  add_test(NAME inspect_test COMMAND map_inspect ${CMAKE_CURRENT_BINARY_DIR}/tiny.bin)
  set_tests_properties(inspect_test PROPERTIES DEPENDS converter_test)
endif()
