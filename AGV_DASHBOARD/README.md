# Luckfox AGV Dashboard

Robot membuka koneksi TCP persisten dan mengirim frame binary status setiap
250 ms. Backend meneruskan status ke browser melalui WebSocket dan mengirim
frame binary command mission pada koneksi TCP yang sama.

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

STOP pada dashboard adalah perintah software dan bukan pengganti emergency stop
hardware yang fail-safe.
