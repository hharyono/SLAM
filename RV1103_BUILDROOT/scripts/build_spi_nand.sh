#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$WORK_DIR/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
ENV_BIN="${CONDA_PREFIX:+$CONDA_PREFIX/bin:}"
CLEAN_PATH="${ENV_BIN}/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Conda compiler activation adds host include/library flags. They must never be
# forwarded to the ARM cross-compiler used by the vendor SDK.
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CMAKE_ARGS CMAKE_PREFIX_PATH \
  CONDA_BUILD_SYSROOT CONDA_TOOLCHAIN_BUILD CONDA_TOOLCHAIN_HOST \
  CC CXX CPP AR AS LD NM OBJCOPY RANLIB STRIP

SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/setup_sdk.sh"

SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/select_board.sh"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/sync_wifi_config.sh"
SDK_DIR="$SDK_DIR" "$ROOT_DIR/RV1106_BUILDROOT/scripts/integrate_localizer.sh"
SDK_DIR="$SDK_DIR" "$ROOT_DIR/LUCKFOX_MAVLINK_BRIDGE/scripts/integrate_buildroot.sh"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/enable_uart3.sh"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/enable_uart4.sh"
if [[ "${RV1103_BOARD_MODEL:-plus}" == mini ]]; then
  SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/enable_uart5.sh"
fi
# Enable the separate ExternalNav output in the RV1103 image.
sed -i 's|^export LUCKFOX_MAVLINK_PORT=.*|export LUCKFOX_MAVLINK_PORT=/dev/ttyS4|' \
  "$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6/package/luckfox-localizer/localize_uart.default"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/enable_usb_host.sh"
SDK_DIR="$SDK_DIR" "$ROOT_DIR/RV1106_BUILDROOT/scripts/enable_rtl8188eus.sh"
SDK_DIR="$SDK_DIR" "$ROOT_DIR/RV1106_BUILDROOT/scripts/enable_wifi_only_build.sh"

cd "$SDK_DIR"
env PATH="$CLEAN_PATH" ./build.sh uboot
env PATH="$CLEAN_PATH" ./build.sh kernel
env PATH="$CLEAN_PATH" ./build.sh rootfs
SDK_DIR="$SDK_DIR" "$ROOT_DIR/RV1106_BUILDROOT/scripts/prepare_wifi_staging.sh"
env PATH="$CLEAN_PATH" LUCKFOX_BUILD_WIFI_ONLY=y ./build.sh app
env PATH="$CLEAN_PATH" ./build.sh firmware

echo "Firmware RV1103 selesai: $SDK_DIR/output/image/update.img"
