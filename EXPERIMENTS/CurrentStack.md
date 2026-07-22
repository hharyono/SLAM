# Current Pipeline SLAM RV1106

Dokumen ini menjelaskan pipeline sistem berdasarkan urutan pemakaian nyata.
Urutan dimulai dari **mapping menggunakan LiDAR pada RV1106**, pengolahan pada
**laptop development**, pembuatan dan transfer map, kemudian penggunaan map
tersebut untuk **localization pada RV1106**.

Kondisi runtime terakhir diverifikasi pada 2026-07-22 sekitar 09:27 ICT.

## Ringkasan urutan sistem

```text
TAHAP A — MEMBUAT MAP

YDLidar
  -> UART RV1106
  -> YDLidar SDK
  -> SCN1 scan frame
  -> Wi-Fi
  -> Laptop development / WSL
  -> ROS 2 scan_tcp_bridge
  -> /scan
  -> RF2O odometry
  -> SLAM Toolbox
  -> /map
  -> dashboard live map
  -> save PGM + YAML
  -> map_align (auto wall-to-X alignment + metric X/Y origin)
  -> map_converter
  -> map.bin
  -> transfer map.bin ke RV1106

TAHAP B — LOCALIZATION MENGGUNAKAN MAP

YDLidar
  -> UART RV1106
  -> YDLidar SDK
  -> range filtering
  -> global correlative search
  -> local pose tracking
  -> localization state
  -> pose/status AGV1
  -> Wi-Fi
  -> backend laptop
  -> WebSocket
  -> dashboard
```

# TAHAP A — PIPELINE MAPPING

## A1. Operator memulai mapping dari dashboard

### Input

Operator menekan:

```text
START MAPPING
```

### Stack yang digunakan

| Layer | Stack |
|---|---|
| UI | React + TypeScript |
| Development server | Vite, port `5173` |
| API | Express + TypeScript, port `8080` |
| Runtime backend | Node.js + `tsx` |
| Backend endpoint | `POST /api/mapping/start` |

### Proses

```text
React dashboard
  -> POST /api/mapping/start
  -> backend mengubah state menjadi starting
  -> backend menjalankan MAPPER/Config/mapper start-remote
  -> backend mengirim START_MISSION ke RV1106
  -> mapping state menjadi running
```

Backend menyalakan pipeline laptop terlebih dahulu agar listener scan sudah
tersedia sebelum board mulai mengirim scan.

## A2. Laptop development menyiapkan pipeline ROS 2 remote

Command `mapper start-remote` menjalankan proses secara berurutan:

```text
1. scan_tcp_bridge
2. static_transform_publisher
3. RF2O
4. SLAM Toolbox
5. RViz2
```

### A2.1 Scan TCP bridge

| Item | Nilai |
|---|---|
| Package | `scan_tcp_bridge` |
| Framework | ROS 2 Humble, `rclcpp` |
| TCP listener | `0.0.0.0:42010` |
| Input protocol | SCN1 binary TCP |
| ROS output | `/scan` |
| Message | `sensor_msgs/msg/LaserScan` |
| QoS | reliable, depth 10 |
| Frame | `laser_frame` |

Metode bridge:

1. menerima TCP connection dari board;
2. mencari header magic SCN1 dan protocol version 1;
3. memvalidasi payload size maksimum 1 MiB;
4. membaca metadata sudut, scan time, range, dan jumlah point;
5. membaca setiap point sebagai `angle`, `range`, dan `intensity`;
6. menempatkan point ke bin LaserScan berdasarkan angle increment;
7. point invalid/out-of-range tetap `infinity`;
8. memublikasikan hasil sebagai `/scan`.

### A2.2 Static transform

Stack:

```text
ROS 2 tf2_ros static_transform_publisher
```

Transform yang digunakan:

```text
base_link -> laser_frame
translation: 0, 0, 0
rotation:    0, 0, 0
```

Transform ini menyatakan bahwa posisi LiDAR saat ini diasumsikan sama dengan
pusat dan orientasi `base_link`.

### A2.3 RF2O laser odometry

| Item | Nilai |
|---|---|
| Package | `rf2o_laser_odometry` |
| Input | `/scan` |
| Output odometry | `/odom_rf2o` |
| TF | `odom -> base_link` |
| Configured frequency | 15 Hz |
| Method | Range Flow-based 2D laser odometry |

RF2O mengestimasi perubahan pose antar-scan LiDAR. Hasilnya menyediakan
odometry dan transform yang dibutuhkan SLAM Toolbox.

### A2.4 SLAM Toolbox

| Item | Nilai |
|---|---|
| Framework | ROS 2 Humble |
| Package | `slam_toolbox` |
| Mode | asynchronous online mapping |
| Input scan | `/scan` |
| Input motion | TF `odom -> base_link` dari RF2O |
| Output | `/map` dan TF `map -> odom` |
| Resolution | 0.05 m/cell |
| Map update interval | 2.0 s |
| Scan matching | aktif |
| Loop closing | aktif |
| Maximum laser range | 10.0 m |
| Minimum laser range | 0.10 m |

Metode yang digunakan:

1. RF2O memberikan estimasi gerak antar-scan;
2. SLAM Toolbox melakukan scan matching terhadap graph/map;
3. pose dan constraint baru ditambahkan ketika perubahan gerak memenuhi
   threshold;
4. loop closure dicari pada area yang pernah dilewati;
5. occupancy grid `/map` diperbarui setiap 2 detik.

### A2.5 RViz2

RViz2 digunakan pada laptop development untuk melihat:

- `/scan`;
- `/map`;
- TF `map -> odom -> base_link -> laser_frame`;
- bentuk dan konsistensi occupancy map selama mapping.

RViz2 hanya alat visualisasi dan bukan bagian runtime localization RV1106.

## A3. Board RV1106 menerima perintah START_MISSION

### Stack yang digunakan

| Layer | Stack |
|---|---|
| Transport | TCP dengan `TCP_NODELAY` |
| Protocol | AGV1 binary version 1 |
| Port | `42000` |
| Board client | C++17 `RobotBackendClient` |
| Callback | `MissionCommand::Start` |

### Alur command

```text
Backend laptop
  -> AGV1 COMMAND START_MISSION
  -> Wi-Fi TCP 42000
  -> RobotBackendClient pada RV1106
  -> mission callback localize_uart
  -> LiDAR scan diaktifkan
  -> AGV1 ACK dikirim ke backend
```

Koneksi AGV1 tetap persisten. Bila terputus, client board mencoba reconnect
setiap sekitar satu detik.

## A4. YDLidar menghasilkan scan pada RV1106

### Hardware dan stack

| Item | Nilai |
|---|---|
| Sensor | YDLidar Tmini Plus SH |
| Board | Luckfox/RV1106 |
| Interface | UART3 `/dev/ttyS3` |
| Baudrate | 230400 |
| Driver runtime | YDLidar SDK C++ |
| Configured scan frequency | 10 Hz |
| Range localizer | 0.05–12.0 m |

### Metode akuisisi

```text
YDLidar optical ranging
  -> serial packet UART
  -> YDLidar SDK packet decoding/checksum
  -> angle + range + intensity samples
  -> CapturedScan
```

Board menggunakan YDLidar SDK langsung. Tidak ada ROS dan OpenCV pada RV1106.

## A5. RV1106 membentuk SCN1 structured scan

### Stack

| Item | Nilai |
|---|---|
| Component | C++17 `ScanTcpClient` |
| Protocol | SCN1 version 1 |
| Destination | `192.168.1.230:42010` |
| Transport | TCP + `TCP_NODELAY` |
| Reconnect | otomatis setiap sekitar 1 detik |

### Isi frame SCN1

Header 16 byte:

```text
magic SCN1
version
frame type
payload length
sequence
```

Metadata scan:

```text
timestamp_ns
angle_min
angle_max
angle_increment
time_increment
scan_time
range_min
range_max
point_count
```

Setiap point membawa:

```text
angle_rad
range_m
intensity
```

Metode pengiriman:

1. thread scan client mengambil scan terbaru;
2. scan yang sama tidak dikirim dua kali;
3. frame network byte order dibentuk;
4. seluruh frame dikirim dengan `SendAll`;
5. jika send gagal, socket ditutup dan dibuat ulang.

## A6. Scan dikirim melalui Wi-Fi ke laptop development

### Topologi aktual

```text
RV1106 wlan0:       192.168.1.24
Gateway/AP:         192.168.1.1
Windows Wi-Fi:      192.168.1.230
WSL2 eth0:          172.26.30.46
```

### Port forwarding

```text
192.168.1.230:42010
  -> Windows portproxy
  -> 172.26.30.46:42010
  -> scan_tcp_bridge di WSL
```

Wi-Fi adalah jalur runtime. USB hanya digunakan bila diperlukan untuk flash,
recovery, atau serial debug lokal.

## A7. Scan menjadi ROS `/scan`

Setelah tiba pada laptop:

```text
SCN1 TCP frame
  -> scan_tcp_bridge parser
  -> angle binning
  -> range validity check
  -> sensor_msgs/LaserScan
  -> ROS topic /scan
```

Topic `/scan` digunakan bersama oleh RF2O dan SLAM Toolbox.

## A8. RF2O dan SLAM Toolbox membangun map

Aliran data lengkap:

```text
/scan
  ├──> RF2O
  │      -> /odom_rf2o
  │      -> TF odom -> base_link
  │
  └──> SLAM Toolbox
         + TF odom -> base_link
         -> scan matching
         -> pose graph
         -> loop closure
         -> occupancy grid /map
         -> TF map -> odom
```

Output akhirnya adalah occupancy grid yang terus diperbarui selama robot/LiDAR
bergerak di lingkungan.

## A9. Live map dikirim ke backend dan dashboard

`scan_tcp_bridge` juga berlangganan `/map`.

### Stack

| Item | Nilai |
|---|---|
| ROS input | `nav_msgs/msg/OccupancyGrid` pada `/map` |
| Protocol output | MAP1 binary version 1 |
| Destination | `127.0.0.1:42020` |
| Receiver | Node/TypeScript backend |
| Browser transport | WebSocket `/ws` |

### Alur

```text
SLAM Toolbox /map
  -> scan_tcp_bridge
  -> encode width, height, resolution, origin, yaw, occupancy data
  -> MAP1 TCP 42020
  -> backend menyimpan liveMap terbaru
  -> WebSocket broadcast
  -> React dashboard menggambar occupancy grid
```

## A10. Map disimpan pada laptop development

Operator menekan:

```text
SAVE MAP
```

Alur:

```text
React dashboard
  -> POST /api/mapping/save
  -> backend menjalankan save_and_convert_map.sh
  -> nav2_map_server map_saver_cli
  -> maps/ruang_utama.pgm
  -> maps/ruang_utama.yaml
```

### Output PGM

PGM menyimpan occupancy grid sebagai grayscale image.

### Output YAML

YAML menyimpan:

- nama PGM;
- resolution;
- map origin;
- negate flag;
- occupied threshold;
- free threshold;
- trinary mode.

## A11. PGM/YAML dikonversi menjadi map.bin

### Stack

| Item | Nilai |
|---|---|
| Tool | C++17 `map_converter` |
| Input | PGM P5/P2 + YAML |
| Output | RV1106 binary map version 1 |
| Validator | `map_inspect` + CRC32 saat load |

### Metode konversi

#### 1. Parse metadata

Converter membaca resolution, origin, negate, mode, dan threshold dari YAML.

#### 2. Occupancy classification

Setiap pixel diubah menjadi:

```text
0 = free
1 = occupied
2 = unknown
```

Klasifikasi menggunakan `occupied_thresh` dan `free_thresh`. Pada trinary map,
grayscale 205 dipertahankan sebagai unknown.

#### 3. Coordinate conversion

PGM dibaca dari baris gambar atas ke bawah, kemudian sumbu Y dibalik agar cocok
dengan koordinat occupancy map ROS.

#### 4. Likelihood field

Converter menghitung jarak setiap cell terhadap obstacle menggunakan two-pass
chamfer distance transform:

```text
horizontal/vertical cost = 1
diagonal cost            = 1.4142
```

Jarak diubah menjadi likelihood:

```text
likelihood = exp(-0.5 * distance² / 4.0)
```

Nilai disimpan sebagai 8-bit 0–255. Unknown cell diberi likelihood 0.

#### 5. Multi-resolution pyramid

Default dibuat empat level. Setiap level berikutnya:

- width dan height dibagi dua;
- resolution dikali dua;
- satu cell mengambil maximum likelihood dari blok 2×2 sebelumnya.

Map aktif saat ini:

```text
L0 150×120 @ 0.05 m
L1  75×60  @ 0.10 m
L2  38×30  @ 0.20 m
L3  19×15  @ 0.40 m
```

#### 6. Binary serialization dan CRC

BIN menyimpan:

- magic `SLAMMAP`;
- map format version;
- dimensions, resolution, dan origin;
- occupancy array;
- seluruh likelihood pyramid;
- CRC32 pada bagian akhir.

Saat map dibuka, magic, version, dimension, payload size, dan CRC diverifikasi.

## A12. map.bin ditransfer kembali ke RV1106

Operator menekan:

```text
TRANSFER MAP
```

### Stack

| Item | Nilai |
|---|---|
| Browser action | REST API |
| Backend endpoint | `POST /api/maps/:name/transfer/:robotId` |
| Transport | AGV1 TCP port `42000` |
| Board receiver | C++17 `RobotBackendClient` |

### Alur transfer

```text
maps/ruang_utama.bin pada laptop
  -> backend membaca binary
  -> AGV1 MAP_FILE frame
  -> Wi-Fi TCP 42000
  -> RV1106 menulis /etc/slam/ruang_utama.bin.new
  -> LoadMap memvalidasi magic/version/size/CRC
  -> map lama diubah menjadi .bak
  -> .new menjadi map aktif
  -> localizer callback reload map
  -> pose tracker reset ke GLOBAL_SEARCH
  -> AGV1 MAP_ACK ke backend/dashboard
```

Map aktif yang terverifikasi pada board:

| Properti | Nilai |
|---|---|
| Path | `/etc/slam/ruang_utama.bin` |
| Size | 42,037 byte |
| Map size | 150×120 |
| Resolution | 0.05 m/cell |
| Origin | `(-5.77, -4.79, 0)` |
| SHA-256 | `a10f2b186c2c08cf390b6b4abed2642d6b685dc404e93c8f72e3e2e950b43da1` |

# TAHAP B — PIPELINE LOCALIZATION

Setelah map tersedia pada RV1106, localization dapat berjalan tanpa ROS dan
tanpa laptop menjalankan RF2O/SLAM Toolbox.

## B1. Boot dan autostart RV1106

### Stack

| Komponen | Fungsi |
|---|---|
| Buildroot/uClibc | OS/runtime target |
| `S30rtl8188eus_wifi` | Menyiapkan RTL8188EUS dan WPA connection |
| `S41dhcpcd` | DHCP untuk `wlan0` |
| `S99zzlocalize_uart` | Autostart localizer |

Urutan service localizer:

```text
load /etc/default/localize_uart
  -> cek /usr/bin/localize_uart
  -> cek /etc/slam/ruang_utama.bin
  -> tunggu /dev/ttyS3
  -> tunggu carrier dan IPv4 wlan0
  -> start localize_uart
```

## B2. Localizer memuat konfigurasi dan map

Konfigurasi aktual board:

```text
MAP=/etc/slam/ruang_utama.bin
UART=/dev/ttyS3
BAUD=230400
LUCKFOX_BACKEND_HOST=192.168.1.230
LUCKFOX_BACKEND_PORT=42000
LUCKFOX_SCAN_STREAM_HOST=192.168.1.230
LUCKFOX_SCAN_STREAM_PORT=42010
LUCKFOX_ROBOT_ID=AGV-001
```

Parameter matcher:

| Parameter | Nilai |
|---|---:|
| Scan frequency | 10 Hz |
| Minimum/maximum range | 0.05 / 12.0 m |
| Local linear window | ±0.5 m |
| Local angular window | ±0.35 rad |
| Linear step | 0.05 m |
| Angular step | 0.0174532925 rad |
| Minimum score | 0.35 |
| LOST after rejection | 3 scan |
| Recovery confirmation | 3 scan |

## B3. Scan diubah menjadi point cloud 2D lokal

```text
angle + range samples
  -> buang range non-finite
  -> buang range di luar 0.05–12.0 m
  -> x = range * cos(angle)
  -> y = range * sin(angle)
  -> vector<Point2f>
```

Point cloud 2D ini menjadi input matcher.

## B4. Initial global localization

Jika localizer belum memiliki pose, metode `GlobalLocalize` digunakan.

### Metode

```text
coarsest pyramid level
  -> evaluasi seluruh cell map
  -> evaluasi yaw -180° sampai <180° dengan step 10°
  -> score semua kandidat
  -> simpan top 12 kandidat
  -> refine top candidates pada level lebih halus
  -> ulang sampai full resolution
  -> kandidat score tertinggi menjadi pose
```

### Correlative score

Untuk setiap kandidat pose:

1. setiap scan point ditransformasikan dari frame robot ke world;
2. world coordinate diubah ke map cell;
3. likelihood cell dijumlahkan;
4. kandidat ditolak dengan score 0 jika point yang masuk map terlalu sedikit;
5. score dinormalisasi terhadap `255 × jumlah seluruh scan point`.

Pose diterima bila:

```text
score >= 0.35
```

Setelah diterima, state menjadi `RECOVERED`.

## B5. Recovery confirmation

Setelah global pose ditemukan:

```text
RECOVERED
  -> local match accepted #1
  -> local match accepted #2
  -> local match accepted #3
  -> TRACKING
```

Tujuannya mencegah satu global candidate langsung dianggap stabil.

## B6. Local pose tracking

Saat pose sudah tersedia, exhaustive search hanya dilakukan di sekitar pose
sebelumnya.

```text
center = previous pose
  -> search ±0.5 m
  -> search ±0.35 rad
  -> mulai dari pyramid kasar
  -> ambil best candidate
  -> perkecil window pada level berikutnya
  -> refine sampai L0 0.05 m
```

Tracking memakai score likelihood yang sama dengan global localization, tetapi
search space jauh lebih kecil.

## B7. Degraded, lost, dan relocalization

```text
TRACKING
  -> score < 0.35
  -> DEGRADED, rejection counter +1

DEGRADED
  -> score kembali >= 0.35
  -> TRACKING, reason tracking_quality_restored

DEGRADED
  -> mencapai 3 consecutive rejection
  -> LOST
  -> previous pose dilepas
  -> scan berikutnya menggunakan GLOBAL_SEARCH

GLOBAL_SEARCH berhasil
  -> RECOVERED
  -> 3 confirmation
  -> TRACKING
```

Setiap perubahan menyimpan `transition_reason` agar state dapat ditelusuri.

## B8. Telemetry localization

Setiap scan dapat ditulis sebagai JSONL pada:

```text
/tmp/localize_scans.jsonl
```

Field utama:

- sequence dan timestamp;
- `x_m`, `y_m`, `yaw_rad`;
- score dan accepted/rejected;
- global/tracking mode;
- current/previous state;
- candidate count;
- raw/valid point count;
- matcher execution dan scan-cycle time;
- transition reason;
- rejection/recovery counters;
- CPU percentage dan RSS.

Saat mission berhenti, firmware menulis heartbeat
`luckfox.localization.resource.v1` setiap satu detik untuk CPU dan RSS idle.
Raw scan dapat diputar ulang menggunakan `localize_replay` dalam mode
`local_only`, `local_global`, `single_resolution`, atau `multi_resolution`.
Pembacaan daya tidak berasal dari board; nilai average/maximum dimasukkan dari
meter eksternal melalui FE pada resource campaign.

## B9. Pose/status dikirim dari RV1106 ke backend

### Stack

| Item | Nilai |
|---|---|
| Client | C++17 `RobotBackendClient` |
| Protocol | AGV1 version 1 |
| Transport | Persistent TCP + `TCP_NODELAY` |
| Destination | `192.168.1.230:42000` |
| Update period | sekitar 250 ms |

Status frame berisi:

```text
robot_id
timestamp
x, y, yaw
score
pose valid
global/tracking mode
mission running
```

Jalur jaringan:

```text
RV1106 192.168.1.24
  -> Wi-Fi
  -> Windows 192.168.1.230:42000
  -> portproxy
  -> WSL 172.26.30.46:42000
  -> Node backend
```

## B10. Backend memproses dan menyiarkan pose

```text
AGV1 status frame
  -> validate magic/version/payload
  -> decode robot status
  -> simpan latest status per robot ID
  -> optional write ROBOT_ARRIVAL_LOG
  -> WebSocket robot_status
  -> React dashboard
```

Backend juga menandai robot offline bila status tidak diperbarui melewati
configured offline timeout.

## B11. Dashboard menampilkan localization

Dashboard menerima snapshot awal dan update WebSocket.

Informasi yang ditampilkan:

- online/offline;
- robot ID;
- mission running/stopped;
- occupancy map;
- posisi `x`, `y`, dan `yaw`;
- arah robot pada map;
- localization score;
- tracking/global mode;
- valid/invalid pose;
- command acknowledgement.

# TAHAP C — STOP DAN RESTART OPERASI

## C1. Stop mission

```text
STOP MISSION
  -> REST API
  -> AGV1 STOP_MISSION
  -> RV1106 menghentikan LiDAR scan
  -> mission_running=false
  -> koneksi backend tetap hidup
  -> pose terakhir tetap dikirim sebagai status
```

## C2. Stop mapping

```text
STOP MAPPING
  -> backend mengirim STOP_MISSION ke board
  -> mapper stop
  -> RViz2 stop
  -> SLAM Toolbox stop
  -> RF2O stop
  -> Static TF stop
  -> ScanBridge stop
```

Map harus disimpan sebelum pipeline mapping dihentikan jika hasilnya ingin
dipakai kembali.

# STATUS PIPELINE SAAT INI

```text
[ACTIVE]   RV1106 wlan0 192.168.1.24
[ACTIVE]   localize_uart service
[ACTIVE]   AGV1 TCP connection port 42000
[ACTIVE]   Node backend port 42000, 42020, dan 8080
[ACTIVE]   React/Vite port 5173
[ONLINE]   AGV-001
[VALID]    Pose terakhir, score sekitar 0.974
[STOPPED]  Mission/LiDAR scanning
[STOPPED]  Scan TCP bridge port 42010
[STOPPED]  RF2O
[STOPPED]  SLAM Toolbox
[STOPPED]  Remote mapping
```

Dengan kondisi tersebut, pipeline yang aktif sekarang adalah:

```text
localize_uart idle tetapi connected
  -> pose/status terakhir
  -> Wi-Fi AGV1
  -> backend
  -> dashboard
```

Pipeline mapping akan aktif setelah operator menekan `START MAPPING`; backend
akan menjalankan `mapper start-remote`, kemudian mengaktifkan mission LiDAR pada
RV1106.

# CATATAN SINKRONISASI DEPLOYMENT

Deployment board saat ini sudah memakai:

```text
map 150×120, hash a10f...
backend Wi-Fi 192.168.1.230
```

Namun artefak rootfs Buildroot yang tersimpan masih membawa:

```text
map lama 354×306, hash 424d...
default backend lama 172.32.0.100
```

Perbedaan ini tidak mengganggu runtime sekarang, tetapi harus disinkronkan
sebelum rebuild atau flash firmware berikutnya.
