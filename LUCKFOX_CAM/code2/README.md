# code2 — eksperimen precision landing satu AprilTag

Varian ini khusus `Calibration/AprilTag36h11_ID0_200mm_A4.pdf`: AprilTag
36h11 ID 0 dengan sisi luar hitam 200 mm. Cetak **Actual size / 100%**.

Folder ini adalah konfigurasi service produksi single-tag dan tetap perlu
dideploy bersama binary. Engine realtime berbagi implementasi teruji di `../src`, tetapi diaktifkan dengan
`single_tag_mode: 1`; hanya ID 0 yang diterima, target adalah pusat tag, dan
seluruh logika handoff multi-tag dilewati karena kandidat lain tidak dibuat.

Build:

```bash
export CONDA_PREFIX=/home/haryono/.local/share/mamba/envs/SLAM
export PATH="$CONDA_PREFIX/bin:$PATH"
./LUCKFOX_CAM/code2/scripts/build_rv1103.sh
```

Hasil build: `code2/build/rv1103/luckfox_landing_single_tag`.

Jika suatu saat ingin dipakai, salin folder `code2` ke `/root/LUCKFOX_CAM/code2`,
pasang `buildroot/precision_landing_single_tag` ke `/usr/bin`, lalu jalankan:

```sh
/usr/bin/precision_landing_single_tag start
/usr/bin/precision_landing_single_tag status
/usr/bin/precision_landing_single_tag stop
```

Service boot `/etc/init.d/S99luckfox_landing` dikonfigurasi untuk binary dan
YAML `code2`, sehingga restart RV maupun restart setelah kalibrasi selalu
kembali ke single-tag ID 0. Engine menolak `single_tag_mode: 0`, sehingga
konfigurasi multi-tag tidak dapat dijalankan tanpa perubahan source.

RTSP default adalah `0` (nonaktif) agar CPU diprioritaskan untuk deteksi.
Detector selalu menggunakan `quad_decimate: 1.0`; tidak ada perubahan adaptif.
