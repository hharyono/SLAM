#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$WORK_DIR/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
SOURCE_BOARD="${RV1106_WIFI_BOARD:-$ROOT_DIR/RV1106_BUILDROOT/luckfox-pico/project/cfg/BoardConfig_IPC/BoardConfig-SPI_NAND-Buildroot-RV1106_Luckfox_Pico_Pro_Max-IPC.mk}"

[[ -L "$SDK_DIR/.BoardConfig.mk" ]] || {
  echo "Board RV1103 belum dipilih" >&2
  exit 1
}
TARGET_BOARD="$(realpath "$SDK_DIR/.BoardConfig.mk")"
[[ -f "$SOURCE_BOARD" ]] || {
  echo "BoardConfig sumber Wi-Fi tidak ditemukan: $SOURCE_BOARD" >&2
  exit 1
}

for key in LF_WIFI_SSID LF_WIFI_PSK; do
  value="${!key:-}"
  if [[ -n "$value" ]]; then
    [[ "$value" != *$'\n'* && "$value" != *'"'* ]] || {
      echo "Konfigurasi $key mengandung karakter yang tidak didukung" >&2
      exit 1
    }
    source_line="export ${key}=\"${value}\""
  else
    source_line="$(grep -m1 "^export ${key}=" "$SOURCE_BOARD" || true)"
    [[ -n "$source_line" ]] || {
      echo "Konfigurasi $key tidak ditemukan pada BoardConfig RV1106" >&2
      exit 1
    }
  fi
  sed -i "s|^export ${key}=.*$|${source_line//|/\\|}|" "$TARGET_BOARD"
done

if [[ -n "${LF_WIFI_SSID:-}" ]]; then
  echo "Konfigurasi koneksi Wi-Fi RV1103 diterapkan dari environment build."
else
  echo "Konfigurasi koneksi Wi-Fi disinkronkan dari target RV1106."
fi
