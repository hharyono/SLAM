#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
CLEAN_PATH=/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BOARD=project/cfg/BoardConfig_IPC/BoardConfig-SPI_NAND-Buildroot-RV1106_Luckfox_Pico_Pro_Max-IPC.mk

cd "$SDK_DIR"
ln -sfn "$BOARD" .BoardConfig.mk
"$WORK_DIR/scripts/enable_uart3.sh"
env PATH="$CLEAN_PATH" ./build.sh kernel
env PATH="$CLEAN_PATH" ./build.sh rootfs
env PATH="$CLEAN_PATH" ./build.sh firmware
