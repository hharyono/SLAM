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

set(YDLIDAR_SDK_ROOT "" CACHE PATH "YDLidar SDK source/install prefix")
if(YDLIDAR_SDK_ROOT)
  find_path(YDLIDAR_INCLUDE_DIR CYdLidar.h
    PATHS "${YDLIDAR_SDK_ROOT}" "${YDLIDAR_SDK_ROOT}/src" NO_DEFAULT_PATH)
  find_library(YDLIDAR_LIBRARY ydlidar_sdk
    PATHS "${YDLIDAR_SDK_ROOT}" "${YDLIDAR_SDK_ROOT}/lib"
          "${YDLIDAR_SDK_ROOT}/build" NO_DEFAULT_PATH)
  if(NOT YDLIDAR_INCLUDE_DIR OR NOT YDLIDAR_LIBRARY)
    message(FATAL_ERROR "YDLidar headers/library not found under YDLIDAR_SDK_ROOT")
  endif()
  add_library(uart_localizer src/uart_localizer.cpp)
  target_include_directories(uart_localizer PUBLIC include PRIVATE
    ${YDLIDAR_INCLUDE_DIR} ${YDLIDAR_SDK_ROOT})
  target_link_libraries(uart_localizer PUBLIC slam_map PRIVATE ${YDLIDAR_LIBRARY} pthread)
  add_executable(localize_uart tools/localize_uart.cpp)
  target_include_directories(localize_uart PRIVATE
    ${YDLIDAR_INCLUDE_DIR} ${YDLIDAR_SDK_ROOT})
  target_link_libraries(localize_uart PRIVATE uart_localizer ${YDLIDAR_LIBRARY} pthread)
endif()

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
