#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
APP_MAKEFILE="$SDK_DIR/project/app/Makefile"

[[ -f "$APP_MAKEFILE" ]] || {
  echo "Makefile aplikasi SDK tidak ditemukan: $APP_MAKEFILE" >&2
  exit 1
}

if grep -q 'ifeq ($(LUCKFOX_BUILD_WIFI_ONLY),y)' "$APP_MAKEFILE"; then
  echo "Filter build khusus wifi_app sudah tersedia."
  exit 0
fi

sed -i '/^app_src := $(dir $(app_src))$/a\
\
ifeq ($(LUCKFOX_BUILD_WIFI_ONLY),y)\
app_src := ./wifi_app/\
endif' "$APP_MAKEFILE"

grep -q 'app_src := ./wifi_app/' "$APP_MAKEFILE" || {
  echo "Gagal menambahkan filter wifi_app ke $APP_MAKEFILE" >&2
  exit 1
}

echo "Filter build khusus wifi_app ditambahkan."
