#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$ROOT_DIR/RV1106_BUILDROOT"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
BR_DIR="$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6"
PKG_DIR="$BR_DIR/package/luckfox-localizer"
YDLIDAR_PKG_DIR="$BR_DIR/package/ydlidar-sdk"
SOURCE_DIR="$ROOT_DIR/LUCKFOX_LOCALIZER"
YDLIDAR_SOURCE_DIR="$ROOT_DIR/MAPPER/YDLidar-SDK"
MAP_FILE="${MAP_FILE:-$ROOT_DIR/maps/ruang_utama.bin}"

[[ -d "$BR_DIR/package" ]] || { echo "Buildroot SDK tidak ditemukan: $BR_DIR" >&2; exit 1; }
[[ -d "$SOURCE_DIR/include" ]] || { echo "Source localizer tidak ditemukan: $SOURCE_DIR" >&2; exit 1; }
[[ -f "$YDLIDAR_SOURCE_DIR/CMakeLists.txt" ]] || { echo "YDLidar SDK tidak ditemukan: $YDLIDAR_SOURCE_DIR" >&2; exit 1; }

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/src/include" "$PKG_DIR/src/src" "$PKG_DIR/src/tools" "$PKG_DIR/src/maps"
cp "$WORK_DIR/package/luckfox-localizer/Config.in" "$PKG_DIR/Config.in"
cp "$WORK_DIR/package/luckfox-localizer/luckfox-localizer.mk" "$PKG_DIR/luckfox-localizer.mk"
cp "$WORK_DIR/package/luckfox-localizer/S99zzlocalize_uart" "$PKG_DIR/S99zzlocalize_uart"
cp "$WORK_DIR/package/luckfox-localizer/localize_uart.default" \
  "$PKG_DIR/localize_uart.default"
cp -a "$SOURCE_DIR/include/." "$PKG_DIR/src/include/"
cp "$SOURCE_DIR/src/crc32.cpp" "$SOURCE_DIR/src/map_io.cpp" \
  "$SOURCE_DIR/src/localizer.cpp" "$SOURCE_DIR/src/uart_localizer.cpp" \
  "$SOURCE_DIR/src/robot_backend_client.cpp" "$PKG_DIR/src/src/"
cp "$SOURCE_DIR/src/scan_tcp_client.cpp" "$PKG_DIR/src/src/"
cp "$SOURCE_DIR/tools/map_inspect.cpp" "$SOURCE_DIR/tools/localize_scan.cpp" \
  "$SOURCE_DIR/tools/localize_uart.cpp" "$PKG_DIR/src/tools/"

rm -rf "$YDLIDAR_PKG_DIR"
mkdir -p "$YDLIDAR_PKG_DIR/src"
cp "$WORK_DIR/package/ydlidar-sdk/Config.in" "$YDLIDAR_PKG_DIR/Config.in"
cp "$WORK_DIR/package/ydlidar-sdk/ydlidar-sdk.mk" "$YDLIDAR_PKG_DIR/ydlidar-sdk.mk"
cp -a "$YDLIDAR_SOURCE_DIR/." "$YDLIDAR_PKG_DIR/src/"
rm -rf "$YDLIDAR_PKG_DIR/src/.git" "$YDLIDAR_PKG_DIR/src/build"

if [[ -f "$MAP_FILE" ]]; then
  cp "$MAP_FILE" "$PKG_DIR/src/maps/ruang_utama.bin"
  echo "Map disertakan: $MAP_FILE"
else
  echo "Peringatan: map tidak ditemukan; binary tetap akan dibuild: $MAP_FILE" >&2
fi

if ! grep -q 'package/luckfox-localizer/Config.in' "$BR_DIR/package/Config.in"; then
  sed -i '0,/^endmenu$/{/^endmenu$/i\ source "package/luckfox-localizer/Config.in"
  }' "$BR_DIR/package/Config.in"
fi
if ! grep -q 'package/ydlidar-sdk/Config.in' "$BR_DIR/package/Config.in"; then
  sed -i '0,/^endmenu$/{/^endmenu$/i\ source "package/ydlidar-sdk/Config.in"
  }' "$BR_DIR/package/Config.in"
fi

DEFCONFIG="$BR_DIR/configs/luckfox_pico_defconfig"
grep -q '^BR2_PACKAGE_LUCKFOX_LOCALIZER=y$' "$DEFCONFIG" || \
  printf '\nBR2_PACKAGE_LUCKFOX_LOCALIZER=y\n' >> "$DEFCONFIG"

echo "Integrasi localizer siap di Buildroot."
