# Luckfox precision landing (RV1103 + SC3336)

Satu proses `luckfox_landing` menjalankan aliran berurutan:

```text
SC3336 frame -> AprilTag 36h11 -> pose/quality gate -> H.264 RTSP tanpa anotasi
                                      -> MAVLink LANDING_TARGET
```

Tidak ada service kamera atau proses RTSP kedua. Profil deteksi runtime yang
sudah tervalidasi pada single-tag tetap dipakai untuk pad multi-tag: memakai
432x240 dengan target 12 fps, H.264 500 kbps, buffer VI dua frame, satu thread
AprilTag, `quad_decimate: 1.0` tetap tanpa adaptive tuning, edge refinement aktif, dan zero-copy VI ke
VENC untuk menjaga latency dan RAM RV1103 32 MB. Intrinsics hasil kalibrasi
1280x720 diskalakan otomatis ke resolusi inference. Snapshot diagnostik tetap
disimpan sebagai PNG, tetapi encoding dan penulisannya berjalan di thread terpisah
agar I/O log tidak menghentikan inferensi.

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
./build/rv1103/luckfox_landing --camera Config/Camera.yaml --config Config/Landing.yaml -rtsp 2
```

- `-rtsp 0`: video tidak diencode atau ditransmisikan; inference dan MAVLink tetap berjalan.
- `-rtsp 1`: transmit RTSP tanpa anotasi.
- `-rtsp 2`: transmit RTSP dengan kotak dan tanda silang pada AprilTag yang sedang dipakai untuk tracking.

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

Landing tersambung ke bridge lokal `127.0.0.1:5761`; Mission Planner memakai
TCP 5763 dan dashboard memakai 5760. Bridge tetap menjadi satu-satunya pemilik UART5 115200 dan tidak boleh
dihentikan. Pengiriman ke UART oleh kedua koneksi diatur per frame MAVLink agar
paket tidak bercampur.

Pesan yang dikirim adalah MAVLink2 `LANDING_TARGET`, frame
`MAV_FRAME_BODY_FRD`, `position_valid=1`: X forward, Y right, Z down dalam meter.
Transformasi pemasangan kamera adalah image-up ke body-forward dan image-right
ke body-right: `body_x=-camera_y`, `body_y=+camera_x`.
Konfigurasi tag, offset kamera, dan quality gate ada di `Config/Landing.yaml`.
Pose valid dikirim pada frame pertama dan memakai filter respons cepat; deteksi
ditolak berdasarkan ID, hamming, decision margin dan reprojection error. Target dinyatakan hilang secara lokal
setelah 1200 ms. Saat target hilang, aplikasi berhenti mengirim `LANDING_TARGET`;
ArduPilot akan membersihkan estimator melalui timeout PrecLand internal dan
melaporkan `PrecLand: Target Lost`.

Geometri multi-tag memakai rantai koordinat eksplisit: posisi pusat tag pada
bidang pad (meter) → offset pusat landing `(116, 205) mm` yang didefinisikan
layout PDF → konversi sumbu cetak (pose tag +X ke kiri kertas, +Y ke atas
kertas) → rotasi pose tag ke
frame kamera OpenCV (+X kanan, +Y bawah, +Z optik) → frame body FRD (+X maju,
+Y kanan, +Z bawah). Offset pad tidak pernah ditambahkan ke piksel atau sudut.

Perpindahan tag dikunci selama 3 frame berurutan dan pusat hasil tag baru
harus konsisten dalam 10 cm terhadap pusat yang sedang dilacak. Deteksi ditahan
bila tag kurang dari 10 piksel, confidence rendah, reprojection error tinggi,
range di luar batas, atau pose melonjak. Setiap frame menulis `PL_FRAME` berisi
timestamp, tag, ukuran piksel, pose mentah, offset meter, pusat akhir, posisi
body FRD, sudut, confidence, status switch, dan alasan pesan dikirim/ditahan.

Checker geometri offline:

```bash
micromamba run -n SLAM python3 LUCKFOX_CAM/tests/check_landing_geometry.py
```

Pad yang direkomendasikan memakai ID unik agar ukuran tag tidak ambigu:

```bash
micromamba run -n SLAM python3 LUCKFOX_CAM/tools/generate_multiscale_apriltags.py
```

Output `Calibration/a4_three_tag_landing_pad_ids_0_1_2.pdf` berisi ID 0
200 mm, ID 1 76 mm, dan ID 2 54 mm pada koordinat yang sama dengan
`Config/Landing_unique_ids.yaml`. Cetak dengan **Actual size / 100%** dan
pastikan garis pemeriksaan benar-benar 50 mm. Aktifkan konfigurasi ID unik di
RV hanya setelah pad fisik lama diganti.

Set ArduPilot:

```text
PLND_ENABLED = 1
PLND_TYPE    = 1
PLND_ALT_MIN = 0.50
PLND_STRICT  = 1
PLND_OPTIONS = existing_options | 4
RNGFND1_TYPE = 10
RNGFND1_ORIENT = 25
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
