#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$WORK_DIR/.." && pwd)"
SOURCE_SDK="${SOURCE_SDK:-$ROOT_DIR/RV1106_BUILDROOT/luckfox-pico}"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"

[[ -d "$SOURCE_SDK/.git" ]] || {
  echo "SDK sumber tidak ditemukan: $SOURCE_SDK" >&2
  exit 1
}

if [[ ! -d "$SDK_DIR/.git" ]]; then
  [[ ! -e "$SDK_DIR" ]] || {
    echo "Target SDK sudah ada tetapi bukan repository Git: $SDK_DIR" >&2
    exit 1
  }

  git clone --local --no-hardlinks "$SOURCE_SDK" "$SDK_DIR"
  source_origin="$(git -C "$SOURCE_SDK" remote get-url origin 2>/dev/null || true)"
  if [[ -n "$source_origin" ]]; then
    git -C "$SDK_DIR" remote set-url origin "$source_origin"
  fi
fi

# Snapshot Buildroot vendor sengaja diabaikan oleh repository SDK utama.
# Salin source dan download cache dari SDK lokal, tetapi jangan menyalin output
# RV1106 agar hasil cross-build RV1103 tetap terisolasi.
SOURCE_BUILDROOT="$SOURCE_SDK/sysdrv/source/buildroot"
TARGET_BUILDROOT="$SDK_DIR/sysdrv/source/buildroot"
if [[ ! -d "$TARGET_BUILDROOT/buildroot-2023.02.6/package" ]]; then
  [[ -d "$SOURCE_BUILDROOT/buildroot-2023.02.6/package" ]] || {
    echo "Snapshot Buildroot sumber tidak ditemukan: $SOURCE_BUILDROOT" >&2
    exit 1
  }
  mkdir -p "$TARGET_BUILDROOT"
  rsync -a \
    --exclude output \
    --exclude '.config' \
    --exclude '.config.old' \
    --exclude '.defconfig' \
    "$SOURCE_BUILDROOT/" "$TARGET_BUILDROOT/"
fi

echo "SDK RV1103 siap pada $SDK_DIR"
