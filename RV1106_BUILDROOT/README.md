# RV1106 SPI NAND Buildroot + Localizer

Folder ini menyimpan integrasi yang reproducible untuk **Luckfox Pico RV1106
Pico Pro/Max SPI NAND**. SDK vendor dan image hasil build sengaja tidak disimpan
di Git karena berukuran beberapa gigabyte.

Board config yang dipakai adalah
`BoardConfig-SPI_NAND-Buildroot-RV1106_Luckfox_Pico_Pro_Max-IPC.mk`.

## Integrasi dan build

SDK berada di `RV1106_BUILDROOT/luckfox-pico`. Dari root repository:

```bash
./RV1106_BUILDROOT/scripts/integrate_localizer.sh
./RV1106_BUILDROOT/scripts/build_spi_nand.sh
```

Skrip build juga mengaktifkan `UART3_M1` pada header board:

- pin 19: UART3 TX
- pin 20: UART3 RX
- device Linux: `/dev/ttyS3`

Port USB DWC3 diubah ke mode **host** agar adaptor Wi-Fi USB dapat dipakai.
Mode gadget `usb0` dan akses SSH melalui alamat USB `172.32.0.93` tidak tersedia
pada image ini; beri daya board secara terpisah dan gunakan Ethernet, Wi-Fi, atau
UART untuk akses.

Skrip yang sama mengaktifkan adaptor Wi-Fi USB **RTL8188EUS**
(`0bda:8179` serta TP-Link `2357:010c/0111`) untuk Luckfox Pico Pro/Max
RV1106:

- driver staging kernel 5.10 `r8188eu.ko` dibangun sebagai module;
- firmware `rtlwifi/rtl8188eufw.bin` dipasang melalui paket
  `linux-firmware` pilihan Realtek 81xx;
- module disalin ke `/oem/usr/ko` bersama module Wi-Fi lain;
- `insmod_wifi.sh` mendeteksi USB product `8179`, memuat dependency
  `lib80211`/`cfg80211`, lalu `r8188eu.ko` saat boot;
- transform `ccm(aes)` diinisialisasi dari process context agar driver staging
  tidak memanggil `request_module()` dari softirq;
- `S30rtl8188eus_wifi` menggunakan backend WEXT, menunggu association selesai,
  lalu menyerahkan konfigurasi IP kepada `dhcpcd`;
- `wifi-health` menampilkan status USB, module, crypto, WPA, alamat, dan route;
- konfigurasi SSID/PSK tetap menggunakan `LF_WIFI_SSID` dan `LF_WIFI_PSK` di
  BoardConfig SDK. Jangan menyimpan kredensial Wi-Fi nyata di Git.

Untuk hanya menerapkan integrasi RTL8188EUS ke SDK tanpa membangun image:

```bash
./RV1106_BUILDROOT/scripts/enable_rtl8188eus.sh
```

Setelah flash, verifikasi dengan:

```sh
lsusb
lsmod | grep r8188eu
ip link show wlan0
dmesg | grep -iE 'r8188eu|0bda|8179'
```

Image hasil build berada di:

- `RV1106_BUILDROOT/luckfox-pico/output/image/rootfs.img`
- `RV1106_BUILDROOT/luckfox-pico/output/image/update.img`

Paket Buildroot memasang:

- `/usr/bin/map_inspect`
- `/usr/bin/localize_scan`
- `/usr/bin/localize_uart`
- `/etc/slam/ruang_utama.bin` bila `maps/ruang_utama.bin` tersedia saat build
- `/etc/init.d/S99zzlocalize_uart` untuk menjalankan localizer otomatis setelah
  konfigurasi jaringan USB selesai saat boot
- `/etc/default/localize_uart` untuk konfigurasi map, UART, baud, dan backend

Localizer otomatis dijalankan oleh BusyBox `rcS` dengan map
`/etc/slam/ruang_utama.bin`, UART `/dev/ttyS3`, dan baud 230400. Kontrol dan
periksa proses dengan:

```sh
/etc/init.d/S99zzlocalize_uart restart
/etc/init.d/S99zzlocalize_uart status
tail -f /tmp/localize_uart.log
```

Telemetri per scan tersimpan sebagai JSONL di `/tmp/localize_scans.jsonl`.
Untuk campaign eksperimen, gunakan script di `EXPERIMENTS/` agar telemetry dan
raw scan memakai experiment ID/path unik dan tidak menimpa bukti mentah.
Backend juga mengirim condition, run type, dan route ID melalui environment;
firmware memvalidasi enam test type pada TestPlanning dan mencantumkan konteks
tersebut pada setiap record telemetry.

Set `ENABLED=0` di `/etc/default/localize_uart` untuk mematikan autostart.
Default endpoint dashboard adalah host Windows `172.32.0.100`, TCP 42000 untuk
status/kontrol robot dan TCP 42010 untuk stream scan. Ubah nilai
`LUCKFOX_BACKEND_*` di file tersebut bila alamat adapter Windows berbeda.

Untuk membaca YDLidar langsung dari UART tanpa CSV:

```sh
localize_uart /etc/slam/ruang_utama.bin /dev/ttyUSB0 0 0 0 230400
```

Nilai pose terakhir yang valid otomatis menjadi tebakan awal frame berikutnya.
Default SDK mengikuti profil mapper `Tmini-Plus-SH.yaml`: baud 230400,
triangular lidar, sample rate 4, intensity 8-bit, reversion/inverted aktif,
range 0.05–12 meter, dan frekuensi scan 10 Hz.
