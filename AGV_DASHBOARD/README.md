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

Buka `http://IP_BACKEND:8080`. Port TCP binary robot adalah `42000`. Atur
`MAP_DIR`, `MAP_NAME`, `ROBOT_TCP_PORT`, atau
`HTTP_PORT` melalui environment bila diperlukan.

Tab **TESTING** mengikuti skenario ringkas pada `EXPERIMENTS/INSTRUKSI.md`:

1. ground-truth repeatability, 10 placement pada satu marker;
2. dua route antarruangan pada kondisi nominal, occlusion 90°, dan perubahan
   furnitur;
3. kidnapped relocation dalam ruangan atau antarruangan;
4. `dynamic_occluded` sebagai test type tersendiri dengan satu orang melintas
   pada marker pemicu `T0`;
5. ablation replay empat konfigurasi tanpa eksperimen fisik baru;
6. resource komputasi untuk idle, tracking, dan global relocalization.

Setiap trial mengikuti lifecycle preflight, session, capture/replay, analyze,
dan finalize. Output immutable dikelompokkan berdasarkan tipe test, misalnya
`EXPERIMENTS/Ouputs/GROUND TRUTH/<experiment_id>`.

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
(`BOARD_SSH_TARGET`, default `192.168.1.24`), kemudian membuat port forwarding
TCP `42000` (status/command) dan `42010` (ScanFrame). Saat rule belum sehat,
backend meminta izin Administrator melalui UAC dan menunggu hasil aktivasi.
Gunakan IP Windows yang dicetak script sebagai `LUCKFOX_BACKEND_HOST` pada
robot. `BOARD_ADDRESS` dapat dipakai bila alamat koneksi board berbeda dari
host pada `BOARD_SSH_TARGET`.
