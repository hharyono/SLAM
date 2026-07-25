#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
MODEL="${RV1103_BOARD_MODEL:-plus}"

case "$MODEL" in
  mini) BOARD_NAME=RV1103_Luckfox_Pico_Mini ;;
  plus) BOARD_NAME=RV1103_Luckfox_Pico_Plus ;;
  webbee) BOARD_NAME=RV1103_Luckfox_Pico_WebBee ;;
  *)
    echo "RV1103_BOARD_MODEL harus mini, plus, atau webbee; diterima: $MODEL" >&2
    exit 1
    ;;
esac

BOARD="project/cfg/BoardConfig_IPC/BoardConfig-SPI_NAND-Buildroot-${BOARD_NAME}-IPC.mk"
[[ -f "$SDK_DIR/$BOARD" ]] || {
  echo "BoardConfig tidak ditemukan: $SDK_DIR/$BOARD" >&2
  exit 1
}

ln -sfn "$BOARD" "$SDK_DIR/.BoardConfig.mk"
echo "Board RV1103 dipilih: $BOARD"
