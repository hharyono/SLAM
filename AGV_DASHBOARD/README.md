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

`START MAPPING` menjalankan ROS remote mapper dan menyalakan LiDAR. `SAVE MAP`
menghasilkan PGM/YAML/BIN. `STOP MAPPING` mematikan LiDAR dan ROS mapping.

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

Board tidak dapat mengakses IP NAT WSL secara langsung. Jalankan script berikut
dari **Windows PowerShell as Administrator**, terutama setelah WSL restart:

```powershell
powershell -ExecutionPolicy Bypass -File \
  "\\wsl.localhost\Ubuntu2204ArduP\root\DATA\SLAM\AGV_DASHBOARD\scripts\setup-wsl-portproxy.ps1"
```

Script mendeteksi IP WSL dan adapter Windows `172.32.x.x`, kemudian membuat
port forwarding TCP `42000` (status/command) dan `42010` (ScanFrame). Gunakan IP
Windows yang dicetak script sebagai `LUCKFOX_BACKEND_HOST` pada robot.
