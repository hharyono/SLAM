#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
MODEL="${RV1103_BOARD_MODEL:-mini}"
[[ "$MODEL" == mini ]] || {
  echo "Skrip UART5_M1 ini khusus Pico Mini; model diterima: $MODEL" >&2
  exit 1
}
DTS="$SDK_DIR/sysdrv/source/kernel/arch/arm/boot/dts/rv1103g-luckfox-pico-mini.dts"
[[ -f "$DTS" ]] || { echo "DTS tidak ditemukan: $DTS" >&2; exit 1; }

# GPIO1_D2/D3 are shared with I2C3_M1 (Mini header pins 14/15).
if grep -q '^&i2c3 {' "$DTS"; then
  sed -i '/^&i2c3 {/,/^};/s/status = "[^"]*";/status = "disabled";/' "$DTS"
else
  printf '\n&i2c3 {\n\tstatus = "disabled";\n};\n' >> "$DTS"
fi
sed -n '/^&i2c3 {/,/^};/p' "$DTS" | grep -q 'status = "disabled";' || {
  echo "Gagal menonaktifkan I2C3 pada $DTS" >&2; exit 1;
}

if grep -q '^&uart5 {' "$DTS"; then
  sed -i '/^&uart5 {/,/^};/c\
\&uart5 {\
\tstatus = "okay";\
\tpinctrl-names = "default";\
\tpinctrl-0 = <\&uart5m1_xfer>;\
};' "$DTS"
else
  cat >> "$DTS" <<'DTS_EOF'

/* UART5_M1 replaces I2C3_M1 on Mini pins 14 (RX) and 15 (TX). */
&uart5 {
	status = "okay";
	pinctrl-names = "default";
	pinctrl-0 = <&uart5m1_xfer>;
};
DTS_EOF
fi
sed -n '/^&uart5 {/,/^};/p' "$DTS" | grep -q 'status = "okay";' || {
  echo "Gagal mengaktifkan UART5_M1 pada $DTS" >&2; exit 1;
}
echo "Pico Mini: UART5_M1 aktif di DTS, I2C3 nonaktif; rebuild dan flash diperlukan."
