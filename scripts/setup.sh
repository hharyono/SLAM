#!/usr/bin/env bash
set -euo pipefail

RepoDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
YdlidarSrc="$RepoDir/MAPPER/YdlidarRos2Ws/src/ydlidar_ros2_driver"
Rf2oSrc="$RepoDir/MAPPER/Rf2oWs/src/rf2o_laser_odometry"

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

source /opt/ros/humble/setup.bash
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

echo "Setup selesai. Jalankan: sudo -E ./MAPPER/Config/mapper start"
