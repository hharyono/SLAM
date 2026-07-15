#!/usr/bin/env bash
set -euo pipefail

RepoDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
YdlidarSrc="$RepoDir/MAPPER/YdlidarRos2Ws/src/ydlidar_ros2_driver"
Rf2oSrc="$RepoDir/MAPPER/Rf2oWs/src/rf2o_laser_odometry"
ScanBridgeSrc="$RepoDir/MAPPER/ScanTcpBridgeWs/src/scan_tcp_bridge"

ApplyPatch() {
    local sourceDir="$1"
    local patchFile="$2"

    if git -C "$sourceDir" apply --reverse --check "$patchFile" 2>/dev/null; then
        echo "Patch sudah diterapkan: $patchFile"
    else
        git -C "$sourceDir" apply --check "$patchFile"
        git -C "$sourceDir" apply "$patchFile"
        echo "Patch diterapkan: $patchFile"
    fi
}

git -C "$RepoDir" submodule update --init --recursive
ApplyPatch "$YdlidarSrc" "$RepoDir/patches/ydlidar_ros2_driver.patch"
ApplyPatch "$Rf2oSrc" "$RepoDir/patches/rf2o_laser_odometry.patch"

# ROS environment hooks may probe optional variables that are not defined.
set +u
source /opt/ros/humble/setup.bash
set -u
colcon --log-base "$RepoDir/MAPPER/YdlidarRos2Ws/log" build \
    --base-paths "$YdlidarSrc" \
    --build-base "$RepoDir/MAPPER/YdlidarRos2Ws/build" \
    --install-base "$RepoDir/MAPPER/YdlidarRos2Ws/install" \
    --symlink-install

colcon --log-base "$RepoDir/MAPPER/Rf2oWs/log" build \
    --base-paths "$Rf2oSrc" \
    --build-base "$RepoDir/MAPPER/Rf2oWs/build" \
    --install-base "$RepoDir/MAPPER/Rf2oWs/install" \
    --symlink-install

colcon --log-base "$RepoDir/MAPPER/ScanTcpBridgeWs/log" build \
    --base-paths "$ScanBridgeSrc" \
    --build-base "$RepoDir/MAPPER/ScanTcpBridgeWs/build" \
    --install-base "$RepoDir/MAPPER/ScanTcpBridgeWs/install" \
    --symlink-install

echo "Setup selesai. Jalankan: sudo -E ./MAPPER/Config/mapper start"
