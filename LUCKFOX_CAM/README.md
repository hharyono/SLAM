# Luckfox precision landing (RV1103 + SC3336)

Satu proses `luckfox_landing` menjalankan aliran berurutan:

```text
SC3336 frame -> AprilTag 36h11 -> pose/quality gate -> H.264 RTSP tanpa anotasi
                                      -> MAVLink LANDING_TARGET
```

Tidak ada service kamera atau proses RTSP kedua. Runtime memakai 432x240, 10 fps,
H.264 500 kbps, buffer VI dua frame, satu thread AprilTag, `quad_decimate: 2.0`,
edge refinement nonaktif, dan zero-copy VI ke
VENC untuk menjaga latency dan RAM RV1103 32 MB. Intrinsics hasil kalibrasi
1280x720 diskalakan otomatis ke resolusi inference.

## Build dan instalasi

```bash
cd /mnt/c/DATA/GITS/Slam/SLAM/LUCKFOX_CAM
./scripts/build_rv1103.sh
```

File runtime pada RV:

| Lokal | RV |
|---|---|
| `build/rv1103/luckfox_landing` | `/root/LUCKFOX_CAM/build/rv1103/luckfox_landing` |
| `Config/*.yaml` | `/root/LUCKFOX_CAM/Config/` |
| `buildroot/S99luckfox_landing` | `/etc/init.d/S99luckfox_landing` |
| `buildroot/luckfox_landing.default` | `/etc/default/luckfox_landing` |

Kontrol service:

```bash
/etc/init.d/S99luckfox_landing start
/etc/init.d/S99luckfox_landing stop
/etc/init.d/S99luckfox_landing restart
/etc/init.d/S99luckfox_landing status
/etc/init.d/S99luckfox_landing enable
/etc/init.d/S99luckfox_landing disable
```

Mode video dipilih dengan parameter `-rtsp`:

```bash
./build/rv1103/luckfox_landing --camera Config/Camera.yaml --config Config/Landing.yaml -rtsp 0
./build/rv1103/luckfox_landing --camera Config/Camera.yaml --config Config/Landing.yaml -rtsp 1
```

- `-rtsp 0`: video tidak diencode atau ditransmisikan; inference dan MAVLink tetap berjalan.
- `-rtsp 1`: transmit RTSP tanpa anotasi.

Untuk service, atur `RTSP_MODE=0` atau `1` di
`/etc/default/luckfox_landing`, lalu restart. Console/log menampilkan status tag,
kecepatan inference, X dan Y maksimum sekali setiap 200 ms.

Video tanpa anotasi dapat dibuka di VLC:

```text
rtsp://192.168.1.55:8554/live
```

Log dan RAM:

```bash
tail -f /tmp/luckfox_landing.log
awk '/MemAvailable/{print}' /proc/meminfo
```

## MAVLink dan precision landing

Landing tersambung ke bridge lokal `127.0.0.1:5761`; Mission Planner tetap di
TCP 5760. Bridge tetap menjadi satu-satunya pemilik UART5 115200 dan tidak boleh
dihentikan. Pengiriman ke UART oleh kedua koneksi diatur per frame MAVLink agar
paket tidak bercampur.

Pesan yang dikirim adalah MAVLink2 `LANDING_TARGET`, frame
`MAV_FRAME_BODY_FRD`, `position_valid=1`: X forward, Y right, Z down dalam meter.
Konfigurasi tag, offset kamera, dan quality gate ada di `Config/Landing.yaml`.
Pose memakai median tiga frame; deteksi ditolak berdasarkan ID, hamming,
decision margin dan reprojection error. Target dinyatakan hilang secara lokal
setelah 300 ms. Saat target hilang, aplikasi berhenti mengirim `LANDING_TARGET`;
ArduPilot akan membersihkan estimator melalui timeout PrecLand internal dan
melaporkan `PrecLand: Target Lost`.

Set ArduPilot:

```text
PLND_ENABLED = 1
PLND_TYPE    = 1
```

## Kalibrasi di PC development

Kalibrasi dilakukan di PC pada 1280x720, bukan pada inference 240p di RV. Pasang
OpenCV contrib, hubungkan kamera ke PC, lalu untuk papan 7x5 dengan kotak 40 mm
dan marker 30 mm jalankan:

```bash
cd /mnt/c/DATA/GITS/Slam/SLAM/LUCKFOX_CAM
pip install opencv-contrib-python numpy
./LuckfoxCam Cal --device /dev/video0 --width 1280 --height 720 \
  --squares-x 7 --squares-y 5 --square-mm 40 --marker-mm 30 --samples 40
```

Ganti `/dev/video0` sesuai kamera pada PC. Preview melakukan auto-capture; ambil
sudut, jarak, dan posisi yang beragam. Hasil hanya disimpan ke
`Config/Camera.yaml` jika reprojection error akhir <= 0.5 px. Setelah itu kirim
file YAML tersebut ke `/root/LUCKFOX_CAM/Config/Camera.yaml` dan restart service.
