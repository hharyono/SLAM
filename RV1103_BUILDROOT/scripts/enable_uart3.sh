#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
MODEL="${RV1103_BOARD_MODEL:-plus}"

case "$MODEL" in
  mini) DTS_NAME=rv1103g-luckfox-pico-mini.dts ;;
  plus) DTS_NAME=rv1103g-luckfox-pico-plus.dts ;;
  webbee) DTS_NAME=rv1103g-luckfox-pico-webbee.dts ;;
  *) echo "Model RV1103 tidak valid: $MODEL" >&2; exit 1 ;;
esac

DTS="$SDK_DIR/sysdrv/source/kernel/arch/arm/boot/dts/$DTS_NAME"
[[ -f "$DTS" ]] || { echo "DTS tidak ditemukan: $DTS" >&2; exit 1; }

if sed -n '/^&uart3 {/,/^};/p' "$DTS" | grep -q 'status = "okay"'; then
  echo "UART3_M1 RV1103 sudah aktif."
  exit 0
fi

if grep -q '^&uart3 {' "$DTS"; then
  sed -i '/^&uart3 {/,/^};/s/status = "disabled"/status = "okay"/' "$DTS"
else
  printf '\n/**********LOCALIZER UART**********/\\n&uart3 {\\n\\tstatus = "okay";\\n};\\n' >>"$DTS"
fi

sed -n '/^&uart3 {/,/^};/p' "$DTS" | grep -q 'status = "okay"' || {
  echo "Gagal mengaktifkan UART3_M1 pada $DTS" >&2
  exit 1
}
echo "UART3_M1 RV1103 aktif sebagai /dev/ttyS3."
