# SLAM Mapper dan Localizer AGV Luckfox RV1106

Repository ini mencakup seluruh alur:

1. membuat occupancy map menggunakan ROS 2 Humble;
2. mengubah map ROS menjadi `map.bin` untuk RV1106;
3. membangun firmware Buildroot awal dengan UART3 dan localizer;
4. cross-compile dan mengirim update `localize_uart` tanpa flash firmware ulang;
5. menjalankan localization langsung dari YDLidar UART;
6. mengirim pose/power melalui TCP binary ke backend TypeScript;
7. menampilkan map dan posisi robot pada frontend React TypeScript.

Target yang sudah diuji:

- host Ubuntu 22.04/WSL2 dengan ROS 2 Humble;
- YDLidar Tmini Plus SH, 230400 baud;
- Luckfox Pico Pro/Max RV1106 SPI NAND;
- UART3_M1: pin 19 TX, pin 20 RX, pin 18 GND, `/dev/ttyS3`;
- Buildroot uClibc, ARM 32-bit.

## 1. Clone repository

```bash
cd ~
git clone --recurse-submodules https://github.com/hharyono/SLAM.git
cd SLAM
```

Jika clone dilakukan tanpa `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

Jangan menyimpan password board di repository. Gunakan placeholder seperti
`IP_LUCKFOX`, `IP_BACKEND`, dan konfigurasi SSH lokal.

## 2. Siapkan host ROS 2

Pasang ROS 2 Humble mengikuti dokumentasi resmi ROS untuk Ubuntu 22.04, lalu
pasang dependency workspace:

```bash
sudo apt update
sudo apt install -y \
  build-essential cmake git pkg-config \
  python3-colcon-common-extensions \
  ros-humble-slam-toolbox \
  ros-humble-nav2-map-server \
  ros-humble-rviz2 \
  ros-humble-tf2-ros
```

Aktifkan ROS pada terminal:

```bash
source /opt/ros/humble/setup.bash
```

### Build dan install YDLidar SDK

```bash
cd ~/SLAM/MAPPER/YDLidar-SDK
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
sudo cmake --install build
sudo ldconfig
```

### Terapkan patch dan build workspace ROS

```bash
cd ~/SLAM
./scripts/setup.sh
```

Script tersebut:

- memastikan seluruh submodule tersedia;
- menerapkan perbaikan RF2O dan profil Tmini Plus SH secara idempotent;
- membangun `MAPPER/YdlidarRos2Ws`;
- membangun `MAPPER/Rf2oWs`.

Patch vendor juga tersedia secara eksplisit di `MAPPER/patches` dan dapat
diterapkan dengan:

```bash
./MAPPER/scripts/apply_mapper_patches.sh
```

## 3. Hubungkan LiDAR ke host mapper

Pastikan device serial terdeteksi dan user memiliki izin:

```bash
ls -l /dev/ttyUSB* 2>/dev/null
sudo usermod -aG dialout "$USER"
```

Logout/login diperlukan setelah menambah group `dialout`. Profil mapper Tmini
Plus SH berada di:

```text
MAPPER/YdlidarRos2Ws/src/ydlidar_ros2_driver/params/Tmini-Plus-SH.yaml
```

Parameter pentingnya adalah 230400 baud, triangular lidar, sample rate 4K,
intensity 8-bit, fixed resolution, 10 Hz, dan range 0.05–12 meter.

## 4. Buat peta awal

Jalankan seluruh mapper:

```bash
cd ~/SLAM
sudo -E ./MAPPER/Config/mapper start
sudo -E ./MAPPER/Config/mapper status
```

Komponen yang dijalankan:

- YDLidar: `/scan`;
- RF2O: `/odom_rf2o`;
- SLAM Toolbox: `/map`;
- TF: `map -> odom -> base_link -> laser_frame`;
- RViz2.

Jika posisi LiDAR tidak tepat di pusat robot, ubah static transform
`base_link -> laser_frame` pada `MAPPER/Config/mapper` sesuai pengukuran fisik.

Periksa topic:

```bash
source /opt/ros/humble/setup.bash
ros2 topic hz /scan
ros2 topic echo /odom_rf2o --once
ros2 topic echo /map --once
```

Gerakkan LiDAR/robot perlahan mengelilingi ruangan sampai dinding pada RViz
rapi dan loop tertutup. Hindari gerak atau putaran mendadak di luar kemampuan
RF2O. Untuk melihat log:

```bash
sudo -E ./MAPPER/Config/mapper logs
```

### Simpan dan konversi map

Saat gambar map sudah stabil, hentikan gerakan robot. Mapper tetap harus hidup
ketika perintah berikut dijalankan:

```bash
cd ~/SLAM
./LUCKFOX_LOCALIZER/scripts/save_and_convert_map.sh ruang_utama
```

Script menyimpan map ROS dan langsung membuat format RV1106:

```text
maps/ruang_utama.pgm
maps/ruang_utama.yaml
maps/ruang_utama.bin
```

Periksa hasil:

```bash
./LUCKFOX_LOCALIZER/build/map_inspect maps/ruang_utama.bin
```

Setelah selesai:

```bash
sudo -E ./MAPPER/Config/mapper stop
```

Map tidak perlu dibuat ulang setiap menjalankan robot. Buat ulang hanya jika
layout ruangan berubah signifikan, skala/origin salah, atau scan tidak lagi
sesuai dengan dinding map.

## 5. Build localizer di host

Build dan unit test native terlebih dahulu:

```bash
cd ~/SLAM/LUCKFOX_LOCALIZER
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
ctest --test-dir build --output-on-failure
```

Core localizer tidak membutuhkan ROS/OpenCV pada target. Scan pertama memakai
global localization seluruh map; frame berikutnya memakai pose sebelumnya.
Jika tracking gagal tiga frame, global localization dijalankan kembali.

## 6. Siapkan Luckfox Buildroot SDK

SDK vendor tidak disimpan di repository ini karena ukurannya besar. Versi yang
telah diuji adalah commit `824b817f8` dari repository Luckfox:

```bash
cd ~/SLAM/RV1106_BUILDROOT
git clone https://github.com/LuckfoxTECH/luckfox-pico.git
cd luckfox-pico
git checkout 824b817f8
cd ~/SLAM
```

Integrasikan source localizer, YDLidar SDK, dan map:

```bash
./RV1106_BUILDROOT/scripts/integrate_localizer.sh
```

Secara default map yang disertakan adalah `maps/ruang_utama.bin`. Untuk nama
lain:

```bash
MAP_FILE="$PWD/maps/nama_map.bin" \
  ./RV1106_BUILDROOT/scripts/integrate_localizer.sh
```

## 7. Build firmware awal Buildroot

Langkah ini diperlukan untuk board baru atau saat kernel, device tree, UART,
atau root filesystem berubah:

```bash
cd ~/SLAM
./RV1106_BUILDROOT/scripts/build_spi_nand.sh
```

Script memilih board berikut dan mengaktifkan UART3_M1:

```text
BoardConfig-SPI_NAND-Buildroot-RV1106_Luckfox_Pico_Pro_Max-IPC.mk
```

Output firmware:

```text
RV1106_BUILDROOT/luckfox-pico/output/image/update.img
```

Flash `update.img` sebagai image utuh menggunakan tool upgrade resmi Luckfox.
Jangan memasukkan `update.img` sebagai file raw ke alamat partisi manual.
Setelah boot, verifikasi:

```sh
dmesg | grep -Ei 'tty|serial|uart'
ls -l /dev/ttyS3
ls -l /usr/bin/localize_uart
ls -l /etc/slam/ruang_utama.bin
```

Output UART yang diharapkan mencantumkan `ff4d0000.serial: ttyS3`.

## 8. Update localizer tanpa flash firmware

Untuk perubahan source localizer berikutnya, jangan rebuild/flash
`update.img`. Build hanya paket Buildroot:

```bash
cd ~/SLAM
./RV1106_BUILDROOT/scripts/integrate_localizer.sh

cd RV1106_BUILDROOT/luckfox-pico/sysdrv/source/buildroot/buildroot-2023.02.6
env PATH=/usr/lib/ccache:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  make luckfox-localizer-dirclean luckfox-localizer -j"$(nproc)"
```

Binary ARM berada di:

```text
output/build/luckfox-localizer-1.0/localize_uart
```

Verifikasi sebelum upload:

```bash
file output/build/luckfox-localizer-1.0/localize_uart
sha256sum output/build/luckfox-localizer-1.0/localize_uart
```

Upload secara aman ke file sementara:

```bash
scp output/build/luckfox-localizer-1.0/localize_uart \
  root@IP_LUCKFOX:/tmp/localize_uart.new
```

Pasang pada board dengan backup:

```bash
ssh root@IP_LUCKFOX
killall localize_uart 2>/dev/null || true
cp /usr/bin/localize_uart /usr/bin/localize_uart.bak
chmod 755 /tmp/localize_uart.new
mv /tmp/localize_uart.new /usr/bin/localize_uart
sha256sum /usr/bin/localize_uart
```

Kirim map baru tanpa firmware ulang:

```bash
scp ~/SLAM/maps/ruang_utama.bin root@IP_LUCKFOX:/tmp/ruang_utama.bin
ssh root@IP_LUCKFOX \
  'install -m 0644 /tmp/ruang_utama.bin /etc/slam/ruang_utama.bin'
```

## 9. Jalankan localizer di Luckfox

Koneksi pin LiDAR ke board:

```text
LiDAR TX -> pin 20 UART3_RX
LiDAR RX -> pin 19 UART3_TX
LiDAR GND -> pin 18 GND
```

Jalankan tanpa backend:

```sh
/usr/bin/localize_uart /etc/slam/ruang_utama.bin /dev/ttyS3 230400
```

Output pose:

```text
x=... y=... yaw=... score=... valid=1 mode=global|tracking evaluated=...
```

`x` dan `y` dalam meter, sedangkan `yaw` dalam radian. Program tidak lagi
memerlukan tebakan awal `x y yaw` karena scan pertama menjalankan global
localization.

## 10. Siapkan Node.js Linux di WSL

FE/BE harus memakai Node Linux, bukan `node.exe` Windows. Verifikasi:

```bash
which node npm
file "$(which node)"
node --version
```

Path yang digunakan konfigurasi F5 adalah:

```text
/usr/local/bin/node
```

Pasang Node.js Linux LTS jika file tersebut belum tersedia. Setelah instalasi,
jalankan dependency:

```bash
cd ~/SLAM/AGV_DASHBOARD/frontend
npm install

cd ../backend
npm install
```

## 11. Jalankan backend dan frontend

### Production/local preview

Build frontend terlebih dahulu. Backend akan menyajikan hasil build frontend:

```bash
cd ~/SLAM/AGV_DASHBOARD/frontend
npm run check
npm run build

cd ../backend
npm run check
npm start
```

Buka:

```text
http://localhost:8080
```

Port yang digunakan:

- `42000/TCP`: koneksi binary robot ↔ backend;
- `42010/TCP`: ScanFrame LiDAR board → ROS scan bridge;
- `42020/TCP`: occupancy grid ROS → Node backend, localhost saja;
- `8080/TCP`: REST, WebSocket, dan frontend production;
- `5173/TCP`: Vite dev server ketika debugging.

### Debug FE dan BE dengan F5

1. Buka folder `~/SLAM` menggunakan VS Code **Remote - WSL**.
2. Pilih `Run and Debug` → `AGV: Debug FE + BE`.
3. Tekan F5.

VS Code menjalankan backend, Vite, dan Chrome debugger. Breakpoint dapat dipasang
langsung pada:

```text
AGV_DASHBOARD/backend/src/server.ts
AGV_DASHBOARD/frontend/src/main.tsx
```

## 12. Hubungkan board ke backend WSL

Board pada jaringan USB `172.32.0.0/16` biasanya tidak dapat mengakses IP NAT
WSL secara langsung. Dari Windows PowerShell **Run as Administrator** jalankan:

```powershell
powershell -ExecutionPolicy Bypass -File `
  "\\wsl.localhost\Ubuntu2204ArduP\root\SLAM\AGV_DASHBOARD\scripts\setup-wsl-portproxy.ps1"
```

Sesuaikan nama distro/path jika berbeda. Script mencetak endpoint Windows,
misalnya:

```text
Luckfox endpoint : 172.32.0.100 ports 42000, 42010
Forwarded to     : 172.26.x.x
```

Gunakan `Luckfox endpoint` sebagai backend host pada board:

```sh
LUCKFOX_BACKEND_HOST=172.32.0.100 \
LUCKFOX_BACKEND_PORT=42000 \
LUCKFOX_SCAN_STREAM_HOST=172.32.0.100 \
LUCKFOX_SCAN_STREAM_PORT=42010 \
LUCKFOX_ROBOT_ID=AGV-001 \
nohup /usr/bin/localize_uart \
  /etc/slam/ruang_utama.bin /dev/ttyS3 230400 \
  >/tmp/localize_backend.log 2>&1 &
```

Periksa proses dan log:

```sh
ps | grep '[l]ocalize_uart'
tail -f /tmp/localize_backend.log
```

## 13. Mapping remote melalui FE/BE

YDLidar SDK tetap berjalan di board untuk decoding UART dan checksum. Backend
tidak menjalankan driver serial YDLidar. Scan terstruktur dikirim melalui TCP
dan diterbitkan `scan_tcp_bridge_node` sebagai `/scan`.

Pipeline tombol `START MAPPING`:

```text
Board YDLidar SDK → TCP 42010 → /scan
                                ├── RF2O → /odom_rf2o
                                └── SLAM Toolbox → /map
                                                     │
React FE ← WebSocket ← Node BE ← map bridge 42020 ───┘
```

Kontrol FE:

- `START MAPPING`: menjalankan `mapper start-remote`, lalu menyalakan LiDAR;
- `SAVE MAP`: menjalankan map saver dan converter PGM/YAML/BIN;
- `TRANSFER MAP TO ROBOT`: mengirim BIN hasil save melalui TCP, memvalidasi
  format/CRC di board, memasangnya ke `/etc/slam`, dan menyimpan map lama
  sebagai `.bak`;
- `STOP MAPPING`: mematikan LiDAR lalu menghentikan ROS stack;
- map `/map` diperbarui langsung pada canvas FE.

Tombol transfer aktif setelah `SAVE MAP` berhasil dan robot berstatus online.
Board otomatis melakukan hot reload setelah validasi berhasil, mereset pose,
dan memakai global localization pada scan berikutnya tanpa restart proses atau
LiDAR.

Verifikasi manual:

```bash
source /opt/ros/humble/setup.bash
ros2 topic hz /scan
ros2 topic echo /odom_rf2o --once
ros2 topic echo /map --once --field info
```

Frekuensi scan Tmini Plus SH yang diharapkan sekitar 10 Hz.

## 14. Verifikasi end-to-end

Pada host backend:

```bash
curl http://localhost:8080/api/robots
```

Hasil yang sehat memiliki:

```json
{
  "robot_id": "AGV-001",
  "pose": {
    "x": 0.0,
    "y": 0.0,
    "yaw": 0.0,
    "score": 0.8,
    "valid": true,
    "mode": "tracking"
  },
  "online": true
}
```

Uji command software:

```bash
curl -X POST http://localhost:8080/api/robots/AGV-001/mission/start
curl -X POST http://localhost:8080/api/robots/AGV-001/mission/stop
```

Pada board, log harus berisi:

```text
mission_command=START
mission_command=STOP
```

START mengaktifkan motor/scan LiDAR dan localization. STOP memanggil `turnOff`,
menghentikan scan/motor LiDAR, dan mempertahankan koneksi status ke backend.
STOP LiDAR ini bukan pengganti emergency stop motor penggerak robot yang
fail-safe.

## 15. Troubleshooting singkat

### `/odom` tidak ada

RF2O repository ini mempublikasikan `/odom_rf2o`, bukan `/odom`:

```bash
ros2 topic echo /odom_rf2o --once
```

### `/dev/ttyS3` tidak ada

Firmware/kernel/device tree lama belum mengaktifkan UART3. Build dan flash
firmware awal pada langkah 7, kemudian periksa `dmesg`.

### Robot offline pada dashboard

```bash
ss -lntp | grep 42000
curl http://localhost:8080/api/robots
```

Jalankan ulang `setup-wsl-portproxy.ps1` setelah WSL restart karena IP NAT WSL
dapat berubah.

### Pose invalid

Pastikan map sesuai ruangan, orientasi/range LiDAR benar, dan tidak ada checksum
UART. Global localization memerlukan struktur dinding yang cukup unik. Skor di
bawah threshold menghasilkan `valid=false`.

### Power `-1`

Pembacaan baterai belum dihubungkan. Integrasikan sensor baterai dengan
`RobotBackendClient::UpdatePower(percent, voltage)`.

### Timestamp robot salah

Jam RTC board dapat kembali ke tahun 2021. Sinkronkan waktu board menggunakan
NTP atau sumber waktu backend jika timestamp absolut diperlukan.
