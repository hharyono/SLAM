# RV1103 SPI NAND Buildroot + Localizer

Target ini menjalankan stack firmware yang sama dengan RV1106:

- localizer dan empat mode replay ABLATION yang sama;
- YDLidar pada UART3 M1 (`/dev/ttyS3`, 230400 baud);
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
