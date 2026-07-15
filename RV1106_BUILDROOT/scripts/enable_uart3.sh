#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
DTS="$SDK_DIR/sysdrv/source/kernel/arch/arm/boot/dts/rv1106-luckfox-pico-pro-max-ipc.dtsi"
BOARD_DTS="$SDK_DIR/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-pro-max.dts"
PATCH="$WORK_DIR/patches/kernel/0001-enable-uart3-m1.patch"

[[ -f "$DTS" ]] || { echo "DTS tidak ditemukan: $DTS" >&2; exit 1; }

if sed -n '/^&uart3 {/,/^};/p' "$DTS" | grep -q 'status = "okay"' &&
   sed -n '/^&uart3 {/,/^};/p' "$BOARD_DTS" | grep -q 'status = "okay"'; then
  echo "UART3_M1 sudah aktif."
  exit 0
fi

patch --forward -d "$SDK_DIR" -p1 < "$PATCH"
echo "UART3_M1 diaktifkan pada pin 19 (TX) dan pin 20 (RX)."
