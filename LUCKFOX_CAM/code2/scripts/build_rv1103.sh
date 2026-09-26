#!/usr/bin/env bash
set -euo pipefail
CODE2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$(cd "$CODE2_DIR/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
SDK_DIR="$REPO_DIR/RV1103_BUILDROOT/luckfox-pico"
MEDIA_DIR="$SDK_DIR/media"
TOOLCHAIN_DIR="$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6/output/host/bin"
BUILD_DIR="$CODE2_DIR/build/rv1103"
APRILTAG_DIR="$APP_DIR/third_party/apriltag"
APRILTAG_BUILD="$BUILD_DIR/apriltag"
[ -x "$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-g++" ] || { echo "RV1103 toolchain missing" >&2; exit 1; }
[ -f "$MEDIA_DIR/out/lib/librockit_full.a" ] || { echo "Media SDK libraries missing" >&2; exit 1; }
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CMAKE_ARGS CMAKE_PREFIX_PATH CONDA_BUILD_SYSROOT CONDA_TOOLCHAIN_BUILD CONDA_TOOLCHAIN_HOST CC CXX CPP AR AS LD NM OBJCOPY RANLIB STRIP
mkdir -p "$APRILTAG_BUILD"
SAMPLE_COMM_EXPOSURE="$BUILD_DIR/libsample_comm_exposure.a"
cp "$MEDIA_DIR/samples/example/common/lib/libsample_comm.a" "$SAMPLE_COMM_EXPOSURE"
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-objcopy" --globalize-symbol=g_aiq_ctx "$SAMPLE_COMM_EXPOSURE"
sources=("$APRILTAG_DIR/apriltag.c" "$APRILTAG_DIR/apriltag_pose.c" "$APRILTAG_DIR/apriltag_quad_thresh.c" "$APRILTAG_DIR/tag36h11.c")
while IFS= read -r source; do sources+=("$source"); done < <(find "$APRILTAG_DIR/common" -maxdepth 1 -name '*.c' | sort)
objects=()
for source in "${sources[@]}"; do
  object="$APRILTAG_BUILD/$(echo "${source#$APRILTAG_DIR/}" | tr '/' '_').o"
  "$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-gcc" -std=gnu99 -Os -march=armv7-a -mfpu=neon -mfloat-abi=hard -I"$APRILTAG_DIR" -c "$source" -o "$object"
  objects+=("$object")
done
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-ar" rcs "$APRILTAG_BUILD/libapriltag.a" "${objects[@]}"
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-g++" -std=gnu++17 -O3 -Wall -Wextra -march=armv7-a -mfpu=neon -mfloat-abi=hard \
  -D_LARGEFILE_SOURCE -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 -DRKPLATFORM=ON -DARCH64=OFF -DISP_HW_V30 -DRV1106 -DUAPI2 \
  -I"$APRILTAG_DIR" -I"$MEDIA_DIR/samples/example/common" -I"$MEDIA_DIR/samples/example/common/isp3.x" -I"$MEDIA_DIR/out/include" \
  -I"$MEDIA_DIR/out/include/rkaiq" -I"$MEDIA_DIR/out/include/rkaiq/uAPI2" -I"$MEDIA_DIR/out/include/rkaiq/common" -I"$MEDIA_DIR/out/include/rkaiq/xcore" \
  -I"$MEDIA_DIR/out/include/rkaiq/algos" -I"$MEDIA_DIR/out/include/rkaiq/iq_parser" -I"$MEDIA_DIR/out/include/rkaiq/iq_parser_v2" \
  "$APP_DIR/src/landing_main.cpp" "$APP_DIR/src/streaming_pipeline.cpp" "$APRILTAG_BUILD/libapriltag.a" -Wl,--start-group \
  "$SAMPLE_COMM_EXPOSURE" "$MEDIA_DIR/out/lib/librockit_full.a" "$MEDIA_DIR/out/lib/librockchip_mpp.a" \
  "$MEDIA_DIR/out/lib/librkaiq.a" "$MEDIA_DIR/out/lib/librtsp.a" "$MEDIA_DIR/out/lib/librga.a" -Wl,--end-group \
  -ldrm -lpthread -ldl -lm -o "$BUILD_DIR/luckfox_landing_single_tag"
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-strip" "$BUILD_DIR/luckfox_landing_single_tag"
echo "Single-tag binary (not deployed): $BUILD_DIR/luckfox_landing_single_tag"
