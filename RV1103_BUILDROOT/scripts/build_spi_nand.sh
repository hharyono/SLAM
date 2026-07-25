#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$WORK_DIR/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
CLEAN_PATH=/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/setup_sdk.sh"

SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/select_board.sh"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/sync_wifi_config.sh"
SDK_DIR="$SDK_DIR" "$ROOT_DIR/RV1106_BUILDROOT/scripts/integrate_localizer.sh"
SDK_DIR="$SDK_DIR" "$WORK_DIR/scripts/enable_uart3.sh"
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
