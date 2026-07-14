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

Image hasil build berada di:

- `RV1106_BUILDROOT/luckfox-pico/output/image/rootfs.img`
- `RV1106_BUILDROOT/luckfox-pico/output/image/update.img`

Paket Buildroot memasang:

- `/usr/bin/map_inspect`
- `/usr/bin/localize_scan`
- `/etc/slam/ruang_utama.bin` bila `maps/ruang_utama.bin` tersedia saat build

`localize_scan` saat ini menerima scan CSV (`angle_radian,range_meter`). Driver
LiDAR realtime perlu memberikan data scan dalam format tersebut atau dihubungkan
ke API localizer.
