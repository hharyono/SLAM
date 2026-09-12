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

# Replace the board override, explicitly selecting the MAVLink UART pins.
if grep -q '^&uart4 {' "$DTS"; then
  sed -i '/^&uart4 {/,/^};/c\
\&uart4 {\
\tstatus = "okay";\
\tpinctrl-names = "default";\
\tpinctrl-0 = <\&uart4m1_xfer>;\
};' "$DTS"
else
  cat >>"$DTS" <<'EOF'

/**********MAVLINK UART**********/
&uart4 {
	status = "okay";
	pinctrl-names = "default";
	pinctrl-0 = <&uart4m1_xfer>;
};
EOF
fi

sed -n '/^&uart4 {/,/^};/p' "$DTS" | grep -q 'status = "okay";' || {
  echo "Gagal mengaktifkan UART4_M1 pada $DTS" >&2
  exit 1
}
echo "UART4_M1 RV1103 aktif di DTS untuk /dev/ttyS4; rebuild dan flash diperlukan."
