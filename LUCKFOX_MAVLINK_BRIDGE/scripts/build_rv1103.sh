#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
SDK_DIR="${SDK_DIR:-$ROOT_DIR/RV1103_BUILDROOT/luckfox-pico}"
TOOLCHAIN="$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6/output/host/bin/arm-rockchip830-linux-uclibcgnueabihf-g++"
[[ -x "$TOOLCHAIN" ]] || { echo "Toolchain RV1103 belum tersedia: $TOOLCHAIN" >&2; exit 1; }
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CMAKE_ARGS CMAKE_PREFIX_PATH \
    CONDA_BUILD_SYSROOT CONDA_TOOLCHAIN_BUILD CONDA_TOOLCHAIN_HOST \
    CC CXX CPP AR AS LD NM OBJCOPY RANLIB STRIP
cmake -S "$APP_DIR" -B "$APP_DIR/build/rv1103" \
    -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=arm \
    -DCMAKE_CXX_COMPILER="$TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build "$APP_DIR/build/rv1103" -j2
echo "Binary ARM: $APP_DIR/build/rv1103/mavlink_bridge"
