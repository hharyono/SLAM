#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="${SDK_DIR:-$WORK_DIR/luckfox-pico}"
KERNEL_DIR="$SDK_DIR/sysdrv/source/kernel"
DEFCONFIG="$KERNEL_DIR/arch/arm/configs/luckfox_rv1106_linux_defconfig"
CCMP_SOURCE="$KERNEL_DIR/net/wireless/lib80211_crypt_ccmp.c"
CCMP_PATCH="$WORK_DIR/patches/0001-lib80211-ccmp-warmup.patch"
INSMOD_WIFI="$SDK_DIR/sysdrv/drv_ko/wifi/insmod_wifi.sh"
APP_MAKEFILE="$SDK_DIR/project/app/Makefile"
BUILDROOT_DEFCONFIGS=(
  "$SDK_DIR/sysdrv/tools/board/buildroot/luckfox_pico_defconfig"
  "$SDK_DIR/sysdrv/source/buildroot/buildroot-2023.02.6/configs/luckfox_pico_defconfig"
)

for required in "$DEFCONFIG" "$INSMOD_WIFI" \
                "$KERNEL_DIR/drivers/staging/rtl8188eu/Makefile" \
                "$CCMP_SOURCE" "$CCMP_PATCH" "$APP_MAKEFILE"; do
  [[ -f "$required" ]] || { echo "File SDK tidak ditemukan: $required" >&2; exit 1; }
done

if ! grep -q 'failed to warm up ccm(aes)' "$CCMP_SOURCE"; then
	patch -d "$KERNEL_DIR" -p1 --forward < "$CCMP_PATCH"
fi

if ! grep -q '^ifeq ($(LUCKFOX_BUILD_WIFI_ONLY),y)$' "$APP_MAKEFILE"; then
  sed -i '/^app_src := $(dir $(app_src))$/a\
\
ifeq ($(LUCKFOX_BUILD_WIFI_ONLY),y)\
app_src := ./wifi_app/\
endif' "$APP_MAKEFILE"
fi

if grep -q '^# CONFIG_R8188EU is not set$' "$DEFCONFIG"; then
  sed -i 's/^# CONFIG_R8188EU is not set$/CONFIG_R8188EU=m/' "$DEFCONFIG"
elif ! grep -q '^CONFIG_R8188EU=m$' "$DEFCONFIG"; then
  sed -i '/^CONFIG_STAGING=y$/a CONFIG_R8188EU=m\nCONFIG_88EU_AP_MODE=y' "$DEFCONFIG"
fi
if ! grep -q '^CONFIG_88EU_AP_MODE=y$' "$DEFCONFIG"; then
  sed -i '/^CONFIG_R8188EU=m$/a CONFIG_88EU_AP_MODE=y' "$DEFCONFIG"
fi

# The staging driver allocates ccm(aes) while transmitting from softirq.
# Keep the complete transform built-in so crypto_alloc_aead() never invokes
# request_module() from atomic context.
for symbol in CRYPTO_CCM CRYPTO_CTR CRYPTO_AES CRYPTO_LIB_AES; do
  if grep -q "^CONFIG_${symbol}=" "$DEFCONFIG"; then
    sed -i "s/^CONFIG_${symbol}=.*/CONFIG_${symbol}=y/" "$DEFCONFIG"
  elif grep -q "^# CONFIG_${symbol} is not set$" "$DEFCONFIG"; then
    sed -i "s/^# CONFIG_${symbol} is not set$/CONFIG_${symbol}=y/" "$DEFCONFIG"
  else
    printf 'CONFIG_%s=y\n' "$symbol" >>"$DEFCONFIG"
  fi
done

for buildroot_defconfig in "${BUILDROOT_DEFCONFIGS[@]}"; do
  [[ -f "$buildroot_defconfig" ]] || continue
  grep -q '^BR2_PACKAGE_LINUX_FIRMWARE=y$' "$buildroot_defconfig" || \
    printf '\nBR2_PACKAGE_LINUX_FIRMWARE=y\n' >>"$buildroot_defconfig"
  grep -q '^BR2_PACKAGE_LINUX_FIRMWARE_RTL_81XX=y$' "$buildroot_defconfig" || \
    printf 'BR2_PACKAGE_LINUX_FIRMWARE_RTL_81XX=y\n' >>"$buildroot_defconfig"
  grep -q '^BR2_PACKAGE_IW=y$' "$buildroot_defconfig" || \
    printf 'BR2_PACKAGE_IW=y\n' >>"$buildroot_defconfig"
  grep -q '^BR2_PACKAGE_WIRELESS_REGDB=y$' "$buildroot_defconfig" || \
    printf 'BR2_PACKAGE_WIRELESS_REGDB=y\n' >>"$buildroot_defconfig"
done

if ! grep -qF '#rtl8188eus' "$INSMOD_WIFI"; then
  sed -i '/^#rtl18188fu$/i\
#rtl8188eus (USB 0bda:8179, TP-Link 2357:010c/0111)\
if grep -qisE "PRODUCT=(.*/8179|2357/0?10c|2357/0?111)/" /sys/bus/usb/devices/*/uevent 2>/dev/null; then\
\tinsmod cfg80211.ko\
\tinsmod r8188eu.ko\
fi\
' "$INSMOD_WIFI"
else
  sed -i 's/insmod 8188eu\.ko/insmod r8188eu.ko/' "$INSMOD_WIFI"
fi

sed -i '/#rtl8188eus/,/^fi$/ {
  s|^#rtl8188eus.*|#rtl8188eus (USB 0bda:8179, TP-Link 2357:010c/0111)|
  s|^if grep .*PRODUCT=.*|if grep -qisE "PRODUCT=(.*/8179\|2357/0?10c\|2357/0?111)/" /sys/bus/usb/devices/*/uevent 2>/dev/null; then|
}' "$INSMOD_WIFI"

if ! sed -n '/#rtl8188eus/,/^fi$/p' "$INSMOD_WIFI" | \
     grep -q 'insmod lib80211\.ko'; then
	sed -i '/#rtl8188eus/,/^fi$/ {
    /insmod cfg80211\.ko/i\
\tinsmod libarc4.ko\
\tinsmod lib80211.ko\
\tinsmod lib80211_crypt_wep.ko\
\tinsmod lib80211_crypt_ccmp.ko
  }' "$INSMOD_WIFI"
fi

sed -i '/#rtl8188eus/,/^fi$/ {
  /insmod libaes\.ko/d
  /insmod aes_generic\.ko/d
  /insmod ctr\.ko/d
  /insmod ccm\.ko/d
}' "$INSMOD_WIFI"

echo "RTL8188EUS aktif: auto-load USB 0bda:8179 dan TP-Link 2357:010c/0111."
