# Luckfox Camera H.264 RTSP server

Aplikasi native RV1103 untuk SC3336: RKAIQ/ISP menghasilkan NV12, hardware VENC
mengodekan H.264, dan server RTSP mengirimkannya melalui RTP agar dapat dibuka
dengan VLC. Service menginisialisasi modul CSI secara minimal tanpa memuat ulang
driver Wi-Fi.

Default: H.264 CBR 1280x720, 25 FPS, 2500 Kbps, GOP 25, RTSP port 8554.

## Build RV1103

```bash
cd /mnt/c/DATA/GITS/Slam/SLAM
micromamba run -n SLAM bash LUCKFOX_CAM/scripts/build_rv1103.sh
```

## File pada board

| Lokal | Board |
|---|---|
| `build/rv1103/luckfox_cam` | `/usr/bin/luckfox_cam` |
| `buildroot/S99luckfox_cam` | `/etc/init.d/S99luckfox_cam` |
| `buildroot/luckfox_cam.default` | `/etc/default/luckfox_cam` |

## VLC

Di VLC pilih **Media > Open Network Stream**, lalu buka:

```text
rtsp://192.168.1.184:8554/live
```

Diagnosis:

```bash
ssh root@192.168.1.184 'tail -f /tmp/luckfox_cam.log'
```

Konfigurasi service ada di `/etc/default/luckfox_cam`. File tuning SC3336 harus
tersedia di `/etc/iqfiles`.

Aktifkan atau nonaktifkan secara permanen (berlaku juga setelah reboot):

```bash
/etc/init.d/S99luckfox_cam enable
/etc/init.d/S99luckfox_cam disable
```
