# SLAM Mapper (ROS 2 Humble)

Konfigurasi mapping 2D menggunakan YDLIDAR Tmini Plus, RF2O laser odometry,
SLAM Toolbox, dan RViz2.

## Clone

```bash
git clone --recurse-submodules https://github.com/hharyono/SLAM.git
cd SLAM
```

Jika repository sudah terlanjur di-clone tanpa submodule:

```bash
git submodule update --init --recursive
```

## Siapkan dependency

Modifikasi terhadap dependency upstream disimpan sebagai patch agar versi dan
perubahannya dapat direproduksi:

```bash
./scripts/setup.sh
```

Script tersebut menerapkan patch driver/RF2O dan membangun kedua workspace.
ROS 2 Humble, `colcon`, dan YDLidar-SDK harus sudah terpasang di sistem.

## Menjalankan mapper

```bash
sudo -E ./MAPPER/Config/mapper start
sudo -E ./MAPPER/Config/mapper status
sudo -E ./MAPPER/Config/mapper logs
sudo -E ./MAPPER/Config/mapper stop
```

Konfigurasi utama:

- `MAPPER/Config/Mapper.yaml`: SLAM Toolbox
- `MAPPER/Rf2oWs/Config/Rf2o.yaml`: RF2O
- `MAPPER/YdlidarRos2Ws/src/ydlidar_ros2_driver/params/Tmini-Plus-SH.yaml`: LiDAR
- `MAPPER/Config/RViz COnfig.rviz`: tampilan RViz

## Topic dan frame

- Laser scan: `/scan`
- RF2O odometry: `/odom_rf2o`
- Map: `/map`
- TF: `map -> odom -> base_link -> laser_frame`

Static transform pada launcher saat ini menganggap `base_link` dan
`laser_frame` berimpit. Sesuaikan enam nilai transform jika posisi fisik LiDAR
terhadap pusat robot tidak nol.

## Map untuk Luckfox Pico RV1106

Converter `map.bin`, loader CRC, dan core scan-to-map localization standalone
tersedia di [`LUCKFOX_LOCALIZER`](LUCKFOX_LOCALIZER/README.md).

Modifikasi terhadap submodule mapper vendor disimpan sebagai patch reproducible
di `MAPPER/patches`. Terapkan setelah `git submodule update --init --recursive`:

```bash
./MAPPER/scripts/apply_mapper_patches.sh
```
