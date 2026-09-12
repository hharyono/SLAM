# MAVLink 2 ExternalNav XY untuk ArduPilot

`localize_uart` mengirim hasil lokalisasi melalui pesan MAVLink 2
`VISION_POSITION_ESTIMATE` (ID 102). Ini masukan estimasi posisi EKF, bukan
perintah tujuan/waypoint. Output serial tidak membutuhkan ROS atau pymavlink
pada Luckfox. Pesan ini didukung untuk ExternalNav oleh
[dokumentasi ArduPilot](https://ardupilot.org/dev/docs/mavlink-nongps-position-estimation.html).

## Port dan menjalankan

- YDLidar: `/dev/ttyS3`, 230400 baud.
- ArduPilot: `/dev/ttyS4`, 115200 baud, 8N1, tanpa flow control.
- RV1103 Plus UART4_M1: TX GPIO1_C5 ke RX TELEM ArduPilot, GND ke GND.
  RX GPIO1_C4 boleh dihubungkan ke TX TELEM untuk pengembangan dua arah;
  implementasi ini hanya mengirim. Gunakan UART TTL 3.3 V, bukan RS-232.

Pastikan image yang sudah mengaktifkan UART4 telah di-flash. Jalankan:

```sh
/etc/init.d/S99zzlocalize_uart stop
LUCKFOX_MAVLINK_PORT=/dev/ttyS4 LUCKFOX_MAVLINK_BAUD=115200 \
  /usr/bin/localize_uart /etc/slam/ruang_utama.bin /dev/ttyS3 230400
```

Konfigurasi permanen di `/etc/default/localize_uart`:

```sh
export LUCKFOX_MAVLINK_PORT=/dev/ttyS4
export LUCKFOX_MAVLINK_BAUD=115200
export LUCKFOX_MAVLINK_SYSID=1
export LUCKFOX_MAVLINK_COMPID=197
export LUCKFOX_MAVLINK_MAP_HEADING_RAD=0
export LUCKFOX_MAVLINK_ORIGIN_X=0
export LUCKFOX_MAVLINK_ORIGIN_Y=0
```

Kemudian `/etc/init.d/S99zzlocalize_uart restart`. Build RV1103 otomatis
mengatur port ini; konfigurasi paket bersama untuk RV1106 tetap opt-in.
Tanpa variabel environment, executable memakai `/dev/ttyS4`.
`LUCKFOX_MAVLINK_PORT=''` menonaktifkan output (berguna untuk replay/pengujian
host atau board tanpa UART4). Baud yang didukung: 57600, 115200, 230400,
460800, 921600. System/component ID harus 1–255; samakan system ID dengan
`SYSID_THISMAV`, dan gunakan component ID berbeda dari autopilot (197 default).

Jika `LUCKFOX_BACKEND_HOST` diset, perilaku mission tetap berlaku: kirim START
dari dashboard agar lidar berjalan dan posisi mulai dikirim. STOP menghentikan
pengiriman posisi. Untuk operasi mandiri tanpa dashboard, hapus/unset variabel
`LUCKFOX_BACKEND_HOST` sebelum menjalankan proses.

## Koordinat

Peta menggunakan meter dan yaw radian berlawanan arah jarum jam, dengan +Y
di kiri +X. MAVLink menggunakan posisi lokal NED (North, East, Down) dan yaw
searah jarum jam dari North. Pesan 102 tidak memiliki field `frame_id`; konvensi
ini ditentukan oleh pengirim dan penerima.

Dengan `h=LUCKFOX_MAVLINK_MAP_HEADING_RAD`, `dx=x-origin_x`, `dy=y-origin_y`:

```text
North = cos(h)*dx + sin(h)*dy
East  = sin(h)*dx - cos(h)*dy
Down  = 0
yaw   = wrap_pi(h - yaw_map)
```

`h` adalah arah +X peta, searah jarum jam dari utara. Default `h=0` berarti
+X peta mengarah utara dan +Y mengarah barat: `(x,y)=(2,3)` menjadi
`(North,East)=(2,-3)`. Untuk peta ENU (+X timur, +Y utara), gunakan
`h=1.57079632679`. Origin adalah titik peta yang akan menjadi `(0,0)` lokal;
tidak otomatis berpindah ke posisi awal atau berganti saat relokalisasi.

Sesuaikan orientasi dan origin dengan peta sebenarnya sebelum memakai hasil
EKF. Posisi localizer adalah posisi sensor lidar. Sesuaikan `VISO_POS_X/Y/Z`
dengan offset sensor terhadap kendaraan, dalam sumbu body forward/right/down.
Roll, pitch dan Z di paket adalah placeholder nol: localizer ini hanya 2D.
Gunakan sumber ketinggian lain. Yaw lidar hanya cocok difusikan bila arah sensor
terhadap body sudah benar dan asumsi gerak planar terpenuhi.

## Pengaturan ArduPilot

Contoh untuk port autopilot `SERIAL2` (nomor ini tidak berhubungan dengan
nomor `/dev/ttyS4` Luckfox). Gunakan nomor SERIAL yang sesuai board FC:

| Parameter | Nilai | Maksud |
|---|---:|---|
| `SERIAL2_PROTOCOL` | 2 | MAVLink 2 |
| `SERIAL2_BAUD` | 115 | 115200 baud |
| `AHRS_EKF_TYPE` | 3 | EKF3 |
| `EK3_ENABLE` | 1 | Aktifkan EKF3 |
| `VISO_TYPE` | 3 | Backend ExternalNav VOXL |
| `EK3_SRC1_POSXY` | 6 | Posisi XY dari ExternalNav |
| `EK3_SRC1_VELXY` | 0 | Tidak ada velocity dari localizer |
| `EK3_SRC1_POSZ` | 1 | Barometer, bukan Z placeholder |
| `EK3_SRC1_VELZ` | 0 | Tidak ada velocity Z |
| `EK3_SRC1_YAW` | 1 | Tetap gunakan compass |

Ini contoh source set 1; pastikan EKF memakai source set tersebut. Ketersediaan
parameter bergantung firmware/jenis kendaraan. Jangan memilih ExternalNav
untuk Z atau velocity dengan output 2D ini. Bila yaw lidar telah divalidasi,
`EK3_SRC1_YAW=6` dapat digunakan sebagai pilihan terpisah.

Tanpa GPS, set **EKF origin** lewat ground station (misalnya Set EKF Origin Here
di Mission Planner) ke lokasi operasi yang sebenarnya, lalu reboot bila
parameter memerlukannya. Menentukan Home saja tidak menggantikan EKF origin.
XY lokal sendiri tidak menentukan latitude/longitude. Aplikasi tidak mengubah
parameter, origin, mode, atau arming ArduPilot secara otomatis.

Covariance belum diestimasi matcher. Payload menandainya sebagai unknown
(`covariance[0]=NaN`); atur `VISO_POS_M_NSE` dan `VISO_YAW_M_NSE` berdasarkan
pengukuran error aktual. Skor scan matching tidak disamakan dengan variance.

## Validitas dan waktu

- Hanya hasil `valid=true` dan state `TRACKING` yang dikirim. `RECOVERED` harus
  selesai menjalani konfirmasi tracking terlebih dahulu.
- Satu pesan per scan yang lolos; tidak mengulang pose lama untuk menaikkan rate.
  ArduPilot membutuhkan setidaknya 4 Hz; ukur rate aktual, bukan hanya setpoint
  `LUCKFOX_SCAN_FREQUENCY_HZ` (default 10 Hz).
- Timestamp berasal dari awal scan SDK (`stamp_ns/1000`). Jalur serial SDK
  standar menggunakan waktu UNIX host. Timestamp nol, mundur/duplikat, masa
  depan, atau lebih tua dari 250 ms ditolak. SDK/sensor dengan timestamp clock
  device yang berbeda perlu sinkronisasi clock sebelum dipakai.
- Relokalisasi/map reload dan restart mission menandai reset; paket valid
  berikutnya menaikkan `reset_counter` setelah sesi pernah mengirim posisi.
  Counter berukuran 8 bit dan dapat wrap. Awal proses baru mulai dari nol.
- Write serial dibatasi 20 ms; scan dilewati bila antrean TX masih berisi data.
  Kegagalan membuka/mengonfigurasi/menulis UART menghentikan proses dengan error
  di log, sehingga masalah koneksi tidak tersembunyi. UART lidar dan MAVLink
  yang sama (termasuk alias symlink) ditolak.
- Tidak ada heartbeat, receive loop, atau MAVLink signing. Jangan memakai
  `wait_heartbeat()` untuk menunggu stream ini. Link FC harus menerima MAVLink
  unsigned; pengaturan keamanan link yang mewajibkan signing belum didukung.

## Verifikasi

Di board, periksa port dan log:

```sh
ls -l /dev/ttyS3 /dev/ttyS4
tail -f /tmp/localize_uart.log
```

Di PC yang tersambung ke TX UART4 melalui adaptor USB–UART 3.3 V:

```sh
python -m pip install pymavlink pyserial
python LUCKFOX_LOCALIZER/tools/mavlink_monitor.py /dev/ttyUSB0 --baud 115200
```

Monitor tidak membutuhkan heartbeat. Verifikasi message ID 102, frame MAVLink
2, rate >=4 Hz saat tracking, dan arah North/East saat sensor digerakkan.
Saat tracking hilang, pesan posisi harus berhenti. Saat tersambung ke FC,
periksa ExternalNav/EKF di ground station dan `LOCAL_POSITION_NED` untuk hasil
fusi. Kehadiran paket saja belum membuktikan EKF menggunakannya.

Build/test host (environment SLAM):

```sh
micromamba run -n SLAM cmake -S LUCKFOX_LOCALIZER -B /tmp/localizer-build
micromamba run -n SLAM cmake --build /tmp/localizer-build -j4
micromamba run -n SLAM ctest --test-dir /tmp/localizer-build --output-on-failure
```

`mavlink_tests` membandingkan byte paket dengan fixture pymavlink 2.4.49,
menguji transformasi koordinat, penyaringan pose, reset dan serial pseudo-TTY.
Fixture dibuat dari common dialect v2, sysid=1, compid=197, seq=42,
usec=123456789, x=2, y=-3, z/roll/pitch/yaw=0, covariance=[NaN, 0 × 20],
reset_counter=7. Definisi wire mengacu pada
[MAVLink common VISION_POSITION_ESTIMATE](https://mavlink.io/en/messages/common.html#VISION_POSITION_ESTIMATE).
