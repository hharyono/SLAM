#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
SDK_DIR="${SDK_DIR:-$ROOT_DIR/RV1103_BUILDROOT/luckfox-pico}"
BR_DIR="$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6"
PKG_DIR="$BR_DIR/package/luckfox-mavlink-bridge"
[[ -d "$BR_DIR/package" ]] || { echo "Buildroot tidak ditemukan: $BR_DIR" >&2; exit 1; }
mkdir -p "$PKG_DIR/src"
cp "$APP_DIR/buildroot/Config.in" "$APP_DIR/buildroot/luckfox-mavlink-bridge.mk" \
   "$APP_DIR/buildroot/S98mavlink_bridge" "$APP_DIR/buildroot/mavlink_bridge.default" "$PKG_DIR/"
cp "$APP_DIR/src/main.cpp" "$PKG_DIR/src/"
# UART5_M1 is enabled by the Mini pipeline. Other profiles require explicit setup.
if [[ "${RV1103_BOARD_MODEL:-plus}" != mini ]]; then
    sed -i 's/^ENABLED=1$/ENABLED=0/' "$PKG_DIR/mavlink_bridge.default"
fi
if ! grep -q 'package/luckfox-mavlink-bridge/Config.in' "$BR_DIR/package/Config.in"; then
    printf '\nsource "package/luckfox-mavlink-bridge/Config.in"\n' >> "$BR_DIR/package/Config.in"
fi
DEFCONFIG="$BR_DIR/configs/luckfox_pico_defconfig"
grep -q '^BR2_PACKAGE_LUCKFOX_MAVLINK_BRIDGE=y$' "$DEFCONFIG" || \
    printf '\nBR2_PACKAGE_LUCKFOX_MAVLINK_BRIDGE=y\n' >> "$DEFCONFIG"
if [[ -f "$BR_DIR/.config" ]]; then
    make -C "$BR_DIR" luckfox-mavlink-bridge-dirclean
fi
echo "Integrasi aplikasi mavlink_bridge siap."
