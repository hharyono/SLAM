# Luckfox AGV Dashboard

Robot membuka koneksi TCP persisten dan mengirim frame binary status setiap
250 ms. Backend meneruskan status ke browser melalui WebSocket dan mengirim
frame binary command mission pada koneksi TCP yang sama.

- `START MISSION`: mengaktifkan motor/scan LiDAR dan localization.
- `STOP MISSION`: menghentikan scan/motor LiDAR tanpa memutus koneksi status.
- `mission_running` menampilkan state aktual yang sudah diterapkan oleh board,
  bukan hanya status command telah dikirim.

Mode mapping remote menggunakan alur:

```text
Luckfox YDLidar SDK → TCP 42010 → ROS /scan → RF2O → SLAM Toolbox → /map
                                                        │
React FE ← WebSocket ← Node BE ← TCP localhost 42020 ───┘
```

`START MAPPING` menjalankan ROS remote mapper dan menyalakan LiDAR.
`SAVE + AUTO ALIGN` memakai nama dari kartu **MAPPING SELECTION** dan menyimpan
PGM/YAML/BIN/alignment JSON sebagai satu entri katalog di folder `maps/`.
Nama map lama tidak ditimpa. `STOP MAPPING` mematikan LiDAR dan ROS mapping.

`ACTIVATE MAP ON ROBOT` mengirim binary terpilih ke board. Board memvalidasi,
memasang sebagai `/etc/slam/ruang_utama.bin`, melakukan hot reload, dan
mengirim ACK. Backend baru menyimpan `maps/active_map.json` dan mengganti map
aktif setelah ACK sukses. Scan berikutnya menjalankan global localization pada
map baru; proses `localize_uart` tidak perlu direstart. Preflight dan config
session eksperimen selalu memakai map aktif tersebut.

## Jalankan

```bash
cd AGV_DASHBOARD/frontend && npm install && npm run build
cd ../backend && npm install && npm start
```

Frontend dan backend ditulis dalam TypeScript strict. Pemeriksaan tipe:

```bash
cd AGV_DASHBOARD/frontend && npx tsc --noEmit
cd ../backend && npm run check
```

Untuk menjaga penggunaan `/tmp` board tetap aman, telemetry JSONL tetap direkam
pada board, sedangkan `raw_scans.csv` untuk run type `route` dan `kidnapped`
ditulis langsung di disk backend dari stream TCP `42010`. Setiap baris memakai
`timestamp_ns` asli dari `ScanFrame` board, bukan waktu tiba di backend, sehingga
tetap dapat dipakai sebagai sumber ablation replay. Backend juga meneruskan frame
ke ROS scan bridge pada port lokal `42011` ketika mapping aktif. Ground truth,
dynamic occlusion, dan resource menghasilkan file raw scan kosong sebagai
penanda manifest tanpa menduplikasi setiap titik LiDAR. Sebelum START dan sesudah
STOP, backend menghapus capture sementara yang stale, mengosongkan log runtime
sementara, memeriksa kapasitas `/tmp`, dan menyimpan kapasitas tersisa ke metadata
session.

Telemetry scan juga menyimpan signature obstacle berukuran kecil:
`front_near_left_points`, `front_near_center_points`,
`front_near_right_points`, dan `front_minimum_range_m`. Analyzer membandingkan
ketiga sektor dengan baseline satu detik sebelum event untuk melaporkan
`object_passing_detected` dan arah angular yang teramati tanpa membutuhkan raw
scan penuh.

Buka `http://IP_BACKEND:8080`. Port TCP binary robot adalah `42000`. Atur
`MAP_DIR`, `MAP_NAME`, `ROBOT_TCP_PORT`, atau
`HTTP_PORT` melalui environment bila diperlukan.

Tab **TESTING** mengikuti skenario ringkas pada `EXPERIMENTS/INSTRUKSI.md`:

1. ground-truth repeatability, 10 placement pada satu marker;
2. dua route antarruangan pada kondisi nominal, occlusion 90°, dan perubahan
   furnitur;
3. kidnapped relocation dalam ruangan atau antarruangan;
4. `dynamic_occluded` sebagai test type tersendiri pada marker fisik M2–M7
   dari `markers_R1.json`: robot berhenti, lalu penghalang tegak 13×13×30 cm
   dilewatkan dari kiri ke kanan sekitar 50 cm di depan LiDAR; backend merekam
   checkpoint marker saat START dan `OCCLUSION END` otomatis 4 detik kemudian;
5. ablation replay faktorial 2×2 (`global OFF/ON × multi-resolution OFF/ON`)
   pada backend host; jika target RV1103/RV1106 dipilih, replay hanya
   memvalidasi metode produksi `global ON + multi-resolution ON`;
6. resource RV1103 dengan dua skenario baru:
   - **LIVE IDLE + TRACKING**: satu interval idle 60 detik, tracking route R1
     60 detik, dan tracking route R2 60 detik. START Tracking R1/R2 otomatis
     mengirim START MISSION; tidak ada tombol Mission manual untuk mode ini;
   - **LIVE ENDURANCE**: session terpisah tanpa batas durasi. UI menampilkan
     elapsed counter serta mode/score localization setiap detik. Robot boleh
     bergerak, diam, atau campuran. START Endurance otomatis mengaktifkan
     mission/LiDAR. Waktu START, END, dan durasi aktual disimpan dalam hasil;
   - **REPLAY**: pilih satu dataset route/kidnapped dari
     `EXPERIMENTS/Accepted/RV1103`, lalu RV1103 menjalankan hanya metode
     produksi `global ON + multi-resolution ON` mengikuti timestamp sensor
     yang direkam. Analyzer melaporkan latency tracking/global, deadline miss,
     CPU, peak RAM, recovery, dan error akhir.

Setiap trial mengikuti lifecycle preflight, session, capture/replay, analyze,
dan finalize. Output immutable dikelompokkan berdasarkan tipe test, misalnya
`EXPERIMENTS/Ouputs/GROUND TRUTH/<experiment_id>`.

Referensi marker route disimpan sebagai katalog bernama hanya di
`EXPERIMENTS/Ouputs/Global/routes/`. Pada tab **TESTING**, gunakan **RESET ALL
MARKERS**, rekam dan lock M1–M8, beri nama referensi, lalu pilih **SAVE TO
GLOBAL**. Semua test fisik memilih **Global route reference** yang sama; ID dan
nama referensi tersebut ikut disimpan dalam metadata session. File lama
`Global/markers_R1.json` dan `markers_R2.json` tetap tersedia sebagai pilihan
legacy, tetapi referensi baru tidak lagi disimpan di browser.

STOP pada dashboard hanya menghentikan LiDAR/localization dan bukan pengganti
emergency stop motor penggerak robot yang fail-safe.

## Debug dengan F5 di VS Code

1. Buka folder repository `/root/DATA/SLAM` di VS Code (gunakan **Remote - WSL**
   jika project berada di WSL).
   Konfigurasi debug sengaja memakai Node Linux `/usr/local/bin/node`, bukan
   instalasi Node Windows.
2. Pastikan `npm install` sudah dijalankan pada folder `frontend` dan `backend`.
3. Buka panel **Run and Debug** dan pilih `AGV: Debug FE + BE`.
4. Tekan **F5**.

VS Code akan menjalankan backend pada `http://localhost:8080`, frontend Vite
pada `http://localhost:5173`, lalu membuka Chrome Debugger. Breakpoint dapat
dipasang langsung pada `backend/src/server.ts` dan `frontend/src/main.tsx`.

## Koneksi Luckfox ke backend WSL

Saat backend dimulai di WSL, backend otomatis memeriksa portproxy Windows dan
menjalankan helper untuk distro pada `WSL_DISTRO_NAME` (default
`Ubuntu2204ArduP`) jika forwarding belum sehat. Windows menampilkan prompt UAC
hanya ketika rule perlu dibuat atau diperbaiki. Set `AUTO_WSL_PORTPROXY=0`
untuk menonaktifkan pemeriksaan otomatis.

Board tidak dapat mengakses IP NAT WSL secara langsung. Jalankan script berikut
dari **Windows PowerShell as Administrator**, terutama setelah WSL restart:

```powershell
powershell -ExecutionPolicy Bypass -File \
  "\\wsl.localhost\Ubuntu2204ArduP\root\DATA\SLAM\AGV_DASHBOARD\scripts\setup-wsl-portproxy.ps1"
```

Script mendeteksi IP WSL dan alamat adapter Windows yang memiliki rute ke board
(`BOARD_SSH_TARGET`, default `192.168.1.231`), kemudian membuat port forwarding
TCP `42000` (status/command) dan `42010` (ScanFrame). Saat rule belum sehat,
backend meminta izin Administrator melalui UAC dan menunggu hasil aktivasi.
Gunakan IP Windows yang dicetak script sebagai `LUCKFOX_BACKEND_HOST` pada
robot. `BOARD_ADDRESS` dapat dipakai bila alamat koneksi board berbeda dari
host pada `BOARD_SSH_TARGET`.
