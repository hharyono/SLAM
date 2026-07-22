#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
CLEAN_PATH=/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BOARD=project/cfg/BoardConfig_IPC/BoardConfig-SPI_NAND-Buildroot-RV1106_Luckfox_Pico_Pro_Max-IPC.mk

"$WORK_DIR/scripts/integrate_localizer.sh"
cd "$SDK_DIR"
ln -sfn "$BOARD" .BoardConfig.mk
"$WORK_DIR/scripts/enable_uart3.sh"
"$WORK_DIR/scripts/enable_usb_host.sh"
"$WORK_DIR/scripts/enable_rtl8188eus.sh"
"$WORK_DIR/scripts/enable_wifi_only_build.sh"
env PATH="$CLEAN_PATH" ./build.sh kernel
env PATH="$CLEAN_PATH" ./build.sh rootfs
"$WORK_DIR/scripts/prepare_wifi_staging.sh"
env PATH="$CLEAN_PATH" LUCKFOX_BUILD_WIFI_ONLY=y ./build.sh app
env PATH="$CLEAN_PATH" ./build.sh firmware
