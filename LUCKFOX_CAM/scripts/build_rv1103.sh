#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
SDK_DIR="$REPO_DIR/RV1103_BUILDROOT/luckfox-pico"
MEDIA_DIR="$SDK_DIR/media"
TOOLCHAIN_DIR="$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6/output/host/bin"
CC="$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-gcc"
BUILD_DIR="$APP_DIR/build/rv1103"
[ -x "$CC" ] || { echo "RV1103 compiler not found: $CC" >&2; exit 1; }
[ -f "$MEDIA_DIR/out/lib/librockit_full.a" ] || {
  echo "Media SDK libraries not built. Build the SDK media target first." >&2; exit 1;
}
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CMAKE_ARGS CMAKE_PREFIX_PATH \
  CONDA_BUILD_SYSROOT CONDA_TOOLCHAIN_BUILD CONDA_TOOLCHAIN_HOST \
  CC CXX CPP AR AS LD NM OBJCOPY RANLIB STRIP
mkdir -p "$BUILD_DIR"
# Low-latency AprilTag landing target application. AprilTag is compiled locally;
# OpenCV is intentionally not linked into the realtime target.
APRILTAG_DIR="$APP_DIR/third_party/apriltag"
APRILTAG_BUILD="$BUILD_DIR/apriltag"
mkdir -p "$APRILTAG_BUILD"
APRILTAG_SOURCES=("$APRILTAG_DIR/apriltag.c" "$APRILTAG_DIR/apriltag_pose.c"
  "$APRILTAG_DIR/apriltag_quad_thresh.c" "$APRILTAG_DIR/tag36h11.c")
while IFS= read -r source; do APRILTAG_SOURCES+=("$source"); done < <(find "$APRILTAG_DIR/common" -maxdepth 1 -name '*.c' | sort)
APRILTAG_OBJECTS=()
for source in "${APRILTAG_SOURCES[@]}"; do
  object="$APRILTAG_BUILD/$(echo "${source#$APRILTAG_DIR/}" | tr '/' '_').o"
  "$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-gcc" -std=gnu99 -Os \
    -march=armv7-a -mfpu=neon -mfloat-abi=hard -I"$APRILTAG_DIR" -c "$source" -o "$object"
  APRILTAG_OBJECTS+=("$object")
done
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-ar" rcs "$APRILTAG_BUILD/libapriltag.a" "${APRILTAG_OBJECTS[@]}"
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-g++" -std=gnu++17 -O3 \
  -Wall -Wextra -march=armv7-a -mfpu=neon -mfloat-abi=hard \
  -D_LARGEFILE_SOURCE -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 \
  -DRKPLATFORM=ON -DARCH64=OFF -DISP_HW_V30 -DRV1106 -DUAPI2 \
  -I"$APRILTAG_DIR" -I"$MEDIA_DIR/samples/example/common" \
  -I"$MEDIA_DIR/samples/example/common/isp3.x" -I"$MEDIA_DIR/out/include" \
  -I"$MEDIA_DIR/out/include/rkaiq" -I"$MEDIA_DIR/out/include/rkaiq/uAPI2" \
  -I"$MEDIA_DIR/out/include/rkaiq/common" -I"$MEDIA_DIR/out/include/rkaiq/xcore" \
  -I"$MEDIA_DIR/out/include/rkaiq/algos" -I"$MEDIA_DIR/out/include/rkaiq/iq_parser" \
  -I"$MEDIA_DIR/out/include/rkaiq/iq_parser_v2" \
  "$APP_DIR/src/landing_main.cpp" "$APP_DIR/src/streaming_pipeline.cpp" \
  "$APRILTAG_BUILD/libapriltag.a" -Wl,--start-group \
  "$MEDIA_DIR/samples/example/common/lib/libsample_comm.a" \
  "$MEDIA_DIR/out/lib/librockit_full.a" "$MEDIA_DIR/out/lib/librockchip_mpp.a" \
  "$MEDIA_DIR/out/lib/librkaiq.a" "$MEDIA_DIR/out/lib/librtsp.a" \
  "$MEDIA_DIR/out/lib/librga.a" -Wl,--end-group \
  -ldrm -lpthread -ldl -lm -o "$BUILD_DIR/luckfox_landing"
echo "Landing binary ARM: $BUILD_DIR/luckfox_landing"

# Calibration-only camera stream: full-resolution frames, no AprilTag/MAVLink.
"$TOOLCHAIN_DIR/arm-rockchip830-linux-uclibcgnueabihf-g++" -std=gnu++17 -O2 \
  -Wall -Wextra -march=armv7-a -mfpu=neon -mfloat-abi=hard \
  -D_LARGEFILE_SOURCE -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 \
  -DRKPLATFORM=ON -DARCH64=OFF -DISP_HW_V30 -DRV1106 -DUAPI2 \
  -I"$MEDIA_DIR/samples/example/common" -I"$MEDIA_DIR/samples/example/common/isp3.x" \
  -I"$MEDIA_DIR/out/include" -I"$MEDIA_DIR/out/include/rkaiq" \
  -I"$MEDIA_DIR/out/include/rkaiq/uAPI2" -I"$MEDIA_DIR/out/include/rkaiq/common" \
  -I"$MEDIA_DIR/out/include/rkaiq/xcore" -I"$MEDIA_DIR/out/include/rkaiq/algos" \
  -I"$MEDIA_DIR/out/include/rkaiq/iq_parser" -I"$MEDIA_DIR/out/include/rkaiq/iq_parser_v2" \
  "$APP_DIR/src/calibration_stream_main.cpp" "$APP_DIR/src/streaming_pipeline.cpp" \
  -Wl,--start-group "$MEDIA_DIR/samples/example/common/lib/libsample_comm.a" \
  "$MEDIA_DIR/out/lib/librockit_full.a" "$MEDIA_DIR/out/lib/librockchip_mpp.a" \
  "$MEDIA_DIR/out/lib/librkaiq.a" "$MEDIA_DIR/out/lib/librtsp.a" \
  "$MEDIA_DIR/out/lib/librga.a" -Wl,--end-group \
  -ldrm -lpthread -ldl -lm -o "$BUILD_DIR/luckfox_cam_call"
echo "Calibration stream binary ARM: $BUILD_DIR/luckfox_cam_call"
