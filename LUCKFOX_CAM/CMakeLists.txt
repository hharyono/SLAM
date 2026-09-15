cmake_minimum_required(VERSION 3.16)
project(luckfox_cam LANGUAGES CXX)

add_executable(luckfox_cam src/main.cpp)
target_compile_features(luckfox_cam PRIVATE cxx_std_17)
target_compile_options(luckfox_cam PRIVATE -Wall -Wextra -Wpedantic)
find_package(Threads REQUIRED)
target_link_libraries(luckfox_cam PRIVATE Threads::Threads)

install(TARGETS luckfox_cam RUNTIME DESTINATION bin)

