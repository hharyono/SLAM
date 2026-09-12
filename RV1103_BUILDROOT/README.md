# RV1103 SPI NAND Buildroot + Localizer

Target ini menjalankan stack firmware yang sama dengan RV1106:

- localizer dan empat mode replay ABLATION yang sama;
- YDLidar pada UART3 M1 (`/dev/ttyS3`, 230400 baud);
- UART4 M1 (`/dev/ttyS4`) diaktifkan untuk koneksi MAVLink ke ArduPilot
  (TX GPIO1_C5, RX GPIO1_C4; pengirim MAVLink dikonfigurasi terpisah);
- adaptor USB Wi-Fi RTL8188EUS yang sama;
- koneksi backend dan scan stream yang sama;
- `S30rtl8188eus_wifi` dan auto-start `S99zzlocalize_uart` yang sama;
- build aplikasi vendor dibatasi ke `wifi_app`.

Image RV1103 tetap dibuat terpisah karena device tree, boot image, dan layout
partisinya tidak kompatibel dengan RV1106. Profil default adalah **Luckfox Pico
Plus RV1103 SPI NAND**. Profil `mini` dan `webbee` juga tersedia.

## Build

Dari root repository:

```bash
./RV1103_BUILDROOT/scripts/build_spi_nand.sh
```

Mengatur koneksi Wi-Fi khusus untuk image RV1103 tanpa menyimpan kredensial ke
Git:

```bash
LF_WIFI_SSID='nama-ssid' LF_WIFI_PSK='password' \
  ./RV1103_BUILDROOT/scripts/build_spi_nand.sh
```

Memilih varian lain:

```bash
RV1103_BOARD_MODEL=mini ./RV1103_BUILDROOT/scripts/build_spi_nand.sh
RV1103_BOARD_MODEL=webbee ./RV1103_BUILDROOT/scripts/build_spi_nand.sh
```

Nilai `RV1103_BOARD_MODEL` yang valid adalah `mini`, `plus`, dan `webbee`.
Luckfox Pico RV1103 biasa hanya mendukung image SD card pada SDK vendor ini,
sehingga tidak dimasukkan ke pipeline SPI NAND.

Skrip membuat clone SDK lokal yang terisolasi di
`RV1103_BUILDROOT/luckfox-pico`, kemudian menyalin konfigurasi SSID/PSK dari
BoardConfig RV1106 lokal tanpa menyimpan kredensial tersebut di Git.

Image akhir:

- `RV1103_BUILDROOT/luckfox-pico/output/image/rootfs.img`
- `RV1103_BUILDROOT/luckfox-pico/output/image/update.img`

Jangan flash `RV1106_BUILDROOT/.../update.img` ke RV1103, atau sebaliknya.

## Setelah flash

```sh
lsusb
lsmod | grep r8188eu
ip link show wlan0
/usr/bin/wifi-health
/etc/init.d/S99zzlocalize_uart status
tail -f /tmp/localize_uart.log
```

USB DWC3 dipakai dalam mode host. Karena itu USB gadget/SSH melalui `usb0`
dinonaktifkan; gunakan catu daya terpisah dan akses melalui Wi-Fi, Ethernet
(bila tersedia pada varian board), atau UART debug.

## Aktivasi UART4

Pipeline build otomatis menjalankan `scripts/enable_uart4.sh`. Untuk hanya
mengaktifkan konfigurasi device tree lokal:

```bash
./RV1103_BUILDROOT/scripts/enable_uart4.sh
```

Perubahan ini memerlukan rebuild firmware dan flash sebelum berlaku di board.
Setelah boot, periksa `ls -l /dev/ttyS3 /dev/ttyS4`. UART3 tetap untuk YDLidar.

## UART5 pada Pico Mini

Profil `mini` otomatis mengalihkan I2C3_M1 menjadi UART5_M1:

| Pin fisik | GPIO | UART5 |
|---|---|---|
| 14 | GPIO1_D2 | RX |
| 15 | GPIO1_D3 | TX |

I2C3 dinonaktifkan. Jangan mengaktifkan I2C3 atau fungsi SPI/PWM yang memakai
kedua pin tersebut bersamaan dengan UART5. UART3 tetap untuk YDLidar dan UART4
untuk MAVLink; UART5 tersedia sebagai port tambahan `/dev/ttyS5`.

```bash
micromamba run -n SLAM env RV1103_BOARD_MODEL=mini \
  ./RV1103_BUILDROOT/scripts/build_spi_nand.sh
```

Target ini adalah **Pico Mini SPI NAND (Mini B)**. Image Plus dan Mini tidak
boleh dipertukarkan. Setelah flash image Mini, periksa pada board:

```sh
ls -l /dev/ttyS3 /dev/ttyS4 /dev/ttyS5
dmesg | grep -E 'ttyS5|ff4f0000'
```

Baud UART5 ditentukan aplikasi yang membukanya; aktivasi device tree tidak
memulai pengiriman data. Uji loopback dengan menghubungkan pin 15 ke pin 14
untuk memverifikasi TX/RX pada board.

## Bridge Mission Planner

Profil Mini menyertakan aplikasi terpisah
[`LUCKFOX_MAVLINK_BRIDGE`](../LUCKFOX_MAVLINK_BRIDGE/README.md), autostart sebagai
`S98mavlink_bridge`: UART5 (`/dev/ttyS5`, 115200 baud) ↔ TCP server port 5760.
Mission Planner memilih TCP lalu menghubungi IP RV1103. Hubungkan UART5 ke
port MAVLink ArduPilot yang berbeda dari port penerima ExternalNav UART4.
