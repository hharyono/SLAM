#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
SDK_DIR="$(realpath "$SDK_DIR")"

# Semua target ini adalah keluaran build. OEM harus dibuat ulang agar file dari
# build aplikasi penuh yang pernah gagal tidak ikut terbawa ke image berikutnya.
TARGETS=(
  "$SDK_DIR/output/out/app_out"
  "$SDK_DIR/project/app/out"
  "$SDK_DIR/output/out/oem"
)

for target in "${TARGETS[@]}"; do
  case "$target" in
    "$SDK_DIR/"*) ;;
    *) echo "Menolak membersihkan path di luar SDK: $target" >&2; exit 1 ;;
  esac
  rm -rf -- "$target"
done

echo "Staging app dan OEM sudah dibersihkan untuk build Wi-Fi saja."
