#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

apply_patch_once() {
  local repository="$1"
  local patch_file="$2"

  if git -C "$repository" apply --reverse --check "$patch_file" 2>/dev/null; then
    echo "Sudah diterapkan: $(basename "$patch_file")"
    return
  fi

  git -C "$repository" apply --check "$patch_file"
  git -C "$repository" apply "$patch_file"
  echo "Diterapkan: $(basename "$patch_file")"
}

apply_patch_once \
  "$ROOT_DIR/MAPPER/Rf2oWs/src/rf2o_laser_odometry" \
  "$ROOT_DIR/MAPPER/patches/rf2o-fixed-scan-and-valid-pose.patch"

apply_patch_once \
  "$ROOT_DIR/MAPPER/YdlidarRos2Ws/src/ydlidar_ros2_driver" \
  "$ROOT_DIR/MAPPER/patches/ydlidar-tmini-plus-sh-profile.patch"
