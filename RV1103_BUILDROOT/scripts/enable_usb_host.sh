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
USB_GADGET_INIT="$SDK_DIR/sysdrv/tools/board/android-tools/S50usbdevice"
[[ -f "$DTS" ]] || { echo "DTS tidak ditemukan: $DTS" >&2; exit 1; }

sed -i '/^&usbdrd_dwc3 {/,/^};/s/dr_mode = "[^"]*";/dr_mode = "host";/' "$DTS"
sed -n '/^&usbdrd_dwc3 {/,/^};/p' "$DTS" | grep -q 'dr_mode = "host";' || {
  echo "Gagal mengaktifkan USB host pada $DTS" >&2
  exit 1
}

if [[ -f "$USB_GADGET_INIT" ]] && ! grep -q 'LUCKFOX_USB_HOST_MODE' "$USB_GADGET_INIT"; then
  sed -i '1a\
# LUCKFOX_USB_HOST_MODE\
if [ "$1" = "start" ]; then\
\techo "USB gadget startup disabled: controller is configured as host"\
\texit 0\
fi' "$USB_GADGET_INIT"
fi

echo "USB DWC3 RV1103 menggunakan mode host."
