#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
BOARD_DTS="$SDK_DIR/sysdrv/source/kernel/arch/arm/boot/dts/rv1106g-luckfox-pico-pro-max.dts"
USB_GADGET_INIT="$SDK_DIR/sysdrv/tools/board/android-tools/S50usbdevice"

[[ -f "$BOARD_DTS" ]] || { echo "DTS tidak ditemukan: $BOARD_DTS" >&2; exit 1; }

if sed -n '/^&usbdrd_dwc3 {/,/^};/p' "$BOARD_DTS" | \
   grep -q 'dr_mode = "host";'; then
  echo "USB DWC3 sudah dalam mode host."
else
  if sed -n '/^&usbdrd_dwc3 {/,/^};/p' "$BOARD_DTS" | grep -q 'dr_mode = '; then
    sed -i '/^&usbdrd_dwc3 {/,/^};/s/dr_mode = "[^"]*";/dr_mode = "host";/' "$BOARD_DTS"
  else
    sed -i '/^&usbdrd_dwc3 {/,/^};/ {
      /status = "okay";/a\
\tdr_mode = "host";
    }' "$BOARD_DTS"
  fi
fi

sed -n '/^&usbdrd_dwc3 {/,/^};/p' "$BOARD_DTS" | \
  grep -q 'dr_mode = "host";' || {
    echo "Gagal mengaktifkan USB host pada $BOARD_DTS" >&2
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

echo "USB DWC3 menggunakan mode host; startup gadget usb0 dinonaktifkan."
