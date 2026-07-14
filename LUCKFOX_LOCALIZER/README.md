# Luckfox Pico RV1106 Map and Localizer

Tool C++17 tanpa ROS/OpenCV untuk mengubah occupancy map ROS menjadi format
biner yang ringan, memvalidasinya di target, dan melakukan scan-to-map
localization.

## Status

Sudah tersedia:

- parser YAML map ROS dan PGM `P5`/`P2`;
- konversi koordinat gambar ke koordinat occupancy map (flip sumbu Y);
- occupancy `free/occupied/unknown`;
- likelihood field berbasis chamfer distance;
- likelihood pyramid multi-resolusi;
- `map.bin` versioned dengan CRC32;
- loader tanpa dependency eksternal;
- multi-resolution correlative scan matcher;
- CLI untuk converter, inspect, dan pengujian scan CSV.
- Input YDLidar realtime dari UART langsung ke localizer tanpa file CSV.

Belum termasuk driver LiDAR realtime. Core localizer menerima titik Cartesian,
sehingga output YDLidar-SDK dapat langsung dikonversi menjadi `Point2f`.

## Build di laptop

```bash
cd LUCKFOX_LOCALIZER
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
ctest --test-dir build --output-on-failure
```

## Simpan dan konversi map

Pastikan mapper masih berjalan dan map di RViz sudah stabil:

```bash
./LUCKFOX_LOCALIZER/scripts/save_and_convert_map.sh ruang_utama
```

Output utama:

```text
maps/ruang_utama.pgm
maps/ruang_utama.yaml
maps/ruang_utama.bin
```

Konversi manual:

```bash
./LUCKFOX_LOCALIZER/build/map_converter map.yaml map.bin
./LUCKFOX_LOCALIZER/build/map_inspect map.bin
```

## Uji localizer offline

File scan CSV memiliki satu pengukuran per baris:

```text
# angle_radians,range_meters
-1.5708,1.25
-1.5533,1.27
0.0000,2.40
```

Jalankan dengan tebakan pose awal:

```bash
./build/localize_scan map.bin scan.csv INITIAL_X INITIAL_Y INITIAL_YAW
```

Untuk YDLidar realtime (default sesuai konfigurasi mapper: 230400 baud):

```bash
./build-uart/localize_uart map.bin /dev/ttyUSB0 INITIAL_X INITIAL_Y INITIAL_YAW 230400
```

Di firmware Luckfox, executable terpasang sebagai `/usr/bin/localize_uart` dan
map sebagai `/etc/slam/ruang_utama.bin`. Port dapat diganti menjadi device UART
board seperti `/dev/ttyS3` bila LiDAR tidak memakai adaptor USB.

Output:

```text
x=... y=... yaw=... score=... valid=1 evaluated=...
```

Tebakan awal harus berada dalam default search window sekitar 0,5 m dan 20°.
Untuk kidnapped-robot/global localization diperlukan search window atau metode
global terpisah.

## Cross-compile RV1106

Salin dan sesuaikan toolchain example dengan lokasi Luckfox Pico SDK:

```bash
cp cmake/rv1106-toolchain.cmake.example cmake/rv1106-toolchain.cmake
cmake -S . -B build-rv1106 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=cmake/rv1106-toolchain.cmake \
  -DBUILD_TESTING=OFF
cmake --build build-rv1106 -j$(nproc)
```

Salin ke board:

```bash
scp build-rv1106/map_inspect build-rv1106/localize_scan maps/ruang_utama.bin root@IP_LUCKFOX:/root/
```

## Format map.bin v1

Semua scalar disimpan little-endian (sesuai x86_64 dan RV1106 ARM):

```text
magic[8] = "SLAMMAP\0"
uint32 version
uint32 width, height
float resolution
float origin_x, origin_y, origin_yaw
uint32 level_count
uint32 occupancy_size
uint8 occupancy[occupancy_size]
for each level:
  uint32 width, height
  float resolution
  uint32 likelihood_size
  uint8 likelihood[likelihood_size]
uint32 crc32
```

Occupancy: `0=free`, `1=occupied`, `2=unknown`. CRC mencakup seluruh byte
sebelum field CRC.

## Integrasi realtime berikutnya

Program target perlu:

1. membuka Tmini Plus melalui YDLidar-SDK;
2. mengubah `(angle, range)` menjadi titik Cartesian;
3. memberikan pose sebelumnya sebagai initial pose;
4. memanggil `luckfox::Localize()`;
5. menerima pose hanya saat `result.valid` dan quality gate terpenuhi.

Untuk robot bergerak, prediksi awal sebaiknya berasal dari encoder/IMU. Scan
matcher saja tidak dapat membedakan gerak besar secara andal jika tebakan awal
keluar dari search window.
