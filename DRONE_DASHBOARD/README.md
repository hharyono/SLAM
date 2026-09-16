# Drone Dashboard

React + TypeScript frontend dan Node.js backend untuk Luckfox RV1103. Dashboard
menampilkan video RTSP, console `luckfox_landing`, baterai, GPS, altitude, speed,
heading, status arm, dan status koneksi MAVLink.

## Requirement PC development

- Node.js 20 atau lebih baru
- npm
- FFmpeg dari environment SLAM (`~/.local/share/mamba/envs/SLAM/bin/ffmpeg`)
- PC berada pada jaringan yang sama dengan RV

Ubuntu/WSL:

```bash
sudo apt update
sudo apt install nodejs npm ffmpeg
```

## Menjalankan

```bash
cd /mnt/c/DATA/GITS/Slam/SLAM/DRONE_DASHBOARD
export PATH="$PWD/../.tools/node/bin:$PATH"
cp .env.example .env
npm install
npm run dev
```

Dashboard memakai Node Linux workspace yang sama dengan AGV Dashboard. Jangan
menjalankan `npm` dari `C:\\Program Files\\nodejs`, karena native dependency
Rollup Windows tidak dapat digunakan oleh VS Code Remote/WSL.

Buka `http://localhost:5173`. Backend Node berada di port 3001. Konfigurasi
default menghubungi MAVLink `192.168.1.55:5760`, RTSP
`rtsp://192.168.1.55:8554/live`, dan menerima status Landing UDP port 14551.

Video hanya diremux (`-c:v copy`) oleh FFmpeg, bukan di-encode ulang. Karena itu
CPU PC rendah dan tidak menambah beban encoding pada RV.

## Production

```bash
npm run build
npm start
```

Buka `http://localhost:3001`.

Catatan: bridge saat ini menyediakan satu slot klien pada port 5760. Tutup
Mission Planner bila dashboard tidak dapat terhubung, atau gunakan port bridge
tambahan bila keduanya harus aktif bersamaan.
