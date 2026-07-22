# Rencana Pengujian Minimum untuk Publikasi Scopus Q3

Dokumen ini menjadi panduan pelaksanaan eksperimen menggunakan **existing stack** pada RV1106, backend, dan frontend AGV Dashboard. Fokus penelitian adalah **checkpoint localization**, kemampuan **global relocalization**, serta kelayakan komputasi pada AGV berkecepatan rendah.

## Ringkasan Campaign

| Pengujian | Jumlah |
|---|---:|
| Pilot untuk memastikan seluruh pipeline bekerja | 1 trial |
| Verifikasi ground-truth placement | 10 pengulangan |
| Akurasi dan robustness pada dua rute | 40 trial |
| Kidnapped robot | 20 trial |
| Pengukuran resource komputasi | 15 pengukuran |
| Ablation dari data yang sudah direkam | Minimal 10 rekaman |

## Research Questions

| ID | Pertanyaan penelitian |
|---|---|
| **RQ1** | Berapa akurasi checkpoint localization pada RV1106? |
| **RQ2** | Bagaimana occlusion statis, occlusion dinamis, dan perubahan susunan ruangan memengaruhi akurasi? |
| **RQ3** | Seberapa berhasil sistem melakukan global relocalization setelah kidnapped-robot event? |
| **RQ4** | Apakah kebutuhan komputasi layak untuk AGV berkecepatan rendah? |

## Alur Umum Setiap Trial

Ikuti urutan berikut agar struktur data setiap trial konsisten:

```text
PREFLIGHT
  -> CREATE SESSION
  -> START CAPTURE
  -> START MISSION
  -> EXECUTE TEST
  -> STOP MISSION
  -> STOP CAPTURE
  -> ANALYZE
  -> REVIEW
  -> FINALIZE
```

> **Catatan:** ablation tidak memerlukan eksperimen fisik baru. Pengujian ini menggunakan replay data yang telah direkam.

---

## 1. Verifikasi Ground Truth

### Tujuan

Menentukan repeatability penempatan robot pada marker dan menyatakan ketidakpastian ground truth.

### Setup

- Gunakan **8 marker** yang tersebar di dua ruangan.
- Gunakan satu marker yang sama untuk pengujian repeatability.
- Pastikan posisi dan arah hadap acuan marker tidak berubah selama pengujian.

### Prosedur

1. Tempatkan robot pada marker acuan.
2. Rekam posisi dan heading robot.
3. Angkat atau pindahkan robot dari marker.
4. Tempatkan kembali robot pada marker yang sama.
5. Ulangi sampai diperoleh **10 placement**.
6. Hitung variasi posisi dan heading.
7. Nyatakan hasilnya sebagai ketidakpastian ground truth.

### Hasil yang Dilaporkan

- Variasi posisi.
- Variasi heading.
- Ketidakpastian ground truth.

---

## 2. Akurasi dan Robustness

### Tujuan

Mengukur akurasi localization pada checkpoint dalam kondisi normal dan tiga kondisi gangguan yang dapat direproduksi di ruangan yang tersedia.

### Rute

| ID pada sistem | Arah rute |
|---|---|
| `R1_ROOM_1_TO_2` | Room 1 → Room 2 |
| `R2_ROOM_2_TO_1` | Room 2 → Room 1 |

Setiap rute harus melewati seluruh marker yang ditentukan. Robot berhenti pada setiap marker agar evaluator dapat merekam estimasi pose dan ground truth checkpoint.

### Matriks Trial

| Kondisi pada sistem | R1 | R2 | Total |
|---|---:|---:|---:|
| `nominal` | 5 | 5 | 10 |
| `lidar_occluded_90` | 5 | 5 | 10 |
| `furniture_changed` | 5 | 5 | 10 |
| `dynamic_occluded` | 5 | 5 | 10 |
| **Total** | **20** | **20** | **40 trial** |

### Skenario Sederhana `dynamic_occluded`

Skenario ini menggunakan satu orang yang berjalan melintasi jalur robot pada lokasi dan waktu pemicu yang sama. Tujuannya bukan meniru seluruh variasi gerakan manusia, melainkan menghasilkan gangguan dinamis sederhana yang dapat diulang.

#### Setup

- Tentukan satu area lintasan dinamis di jalur penghubung dua ruangan.
- Pasang marker lantai `H1` dan `H2` sebagai titik awal dan akhir pejalan kaki.
- Lintasan `H1` → `H2` dibuat memotong jalur robot secara tegak lurus.
- Pasang marker `T0` pada jalur robot sebagai pemicu orang mulai berjalan.
- Pertahankan jarak aman minimal **1 meter** antara orang dan robot.
- Gunakan orang yang sama pada seluruh trial jika memungkinkan.
- Gunakan kecepatan robot yang sama pada seluruh trial.
- Pastikan tidak ada orang lain yang masuk ke area pengujian.

#### Prosedur

1. Operator berdiri diam di `H1`, di luar jalur robot.
2. Jalankan robot dari titik awal sesuai rute yang dipilih.
3. Saat bagian depan robot mencapai `T0`, operator mulai berjalan dari `H1` menuju `H2`.
4. Operator berjalan normal tanpa berhenti dengan target durasi lintasan **3 ± 0,5 detik**.
5. Operator berhenti di `H2` dan tidak kembali melintasi jalur pada trial yang sama.
6. Robot melanjutkan rute dan berhenti pada setiap checkpoint seperti pengujian lainnya.
7. Untuk arah rute sebaliknya, gunakan urutan `H2` → `H1` dengan aturan yang sama.
8. Hentikan dan ulangi trial apabila orang berhenti di tengah lintasan, jarak aman dilanggar, atau ada orang lain memasuki area.

#### Kontrol Reproduksibilitas

Catat kondisi berikut pada hasil trial:

- Marker pemicu yang digunakan: `T0`.
- Arah lintasan orang: `H1_TO_H2` atau `H2_TO_H1`.
- Durasi aktual orang melintas.
- Apakah trial valid atau harus diulang.

### Prosedur

1. Pilih kondisi dan rute pada frontend.
2. Buat session, lalu mulai capture dan mission.
3. Jalankan robot mengikuti rute yang dipilih.
4. Hentikan robot pada setiap marker.
5. Rekam checkpoint localization pada setiap marker.
6. Setelah seluruh marker selesai, hentikan mission dan capture.
7. Jalankan analisis, periksa hasil, lalu finalisasi trial.
8. Ulangi sampai jumlah trial pada matriks terpenuhi.

### Metrik

- Position RMSE.
- Heading RMSE.
- Median error.
- P95 error.
- Maximum error.
- Success rate.
- 95% confidence interval.

> **Batas klaim:** gunakan istilah **checkpoint localization accuracy**. Jangan mengklaim **trajectory accuracy**, karena ground truth hanya tersedia pada checkpoint.

---

## 3. Kidnapped Robot

### Tujuan

Mengukur kemampuan sistem mendeteksi pose yang tidak lagi sesuai dan melakukan global relocalization setelah robot dipindahkan secara manual.

### Kategori Trial

| ID pada sistem | Relocation | Jumlah |
|---|---|---:|
| `KIDNAP_SAME_ROOM` | Dalam ruangan yang sama | 10 |
| `KIDNAP_CROSS_ROOM` | Antar-ruangan | 10 |
| **Total** |  | **20 trial** |

### Prosedur

1. Jalankan mission dan tempatkan robot di posisi awal **A**.
2. Tunggu sampai status localization stabil pada `TRACKING`.
3. Tekan **KIDNAP START** pada frontend.
4. Tutup bidang pandang LiDAR menggunakan penutup yang aman, atau hentikan pemrosesan scan jika mekanisme tersebut tersedia.
5. Pindahkan robot secara manual ke marker tujuan **B** dan atur orientasinya sesuai skenario.
6. Pilih marker B pada evaluator sebagai ground truth. Referensi ini hanya boleh digunakan oleh evaluator/backend dan **tidak boleh dikirim ke localizer**.
7. Buka kembali penutup LiDAR dan tekan **KIDNAP RELEASE**.
8. Rekam waktu scan pertama setelah pelepasan.
9. Tunggu sistem mendeteksi ketidakcocokan, masuk ke `GLOBAL SEARCH`, memperoleh pose valid, dan kembali ke `TRACKING`.
10. Batasi waktu recovery maksimal **60 detik**.
11. Rekam final checkpoint, lalu hentikan mission dan capture.
12. Jalankan analisis, periksa hasil, dan finalisasi trial.

> **Penting:** firmware board tidak diperintahkan untuk mematikan sensor LiDAR. Kidnapped event dilakukan dengan memindahkan robot secara manual; LiDAR hanya ditutup secara aman atau pemrosesan scan dihentikan selama perpindahan. Setelah robot ditempatkan di B, kondisi LiDAR dikembalikan normal.

### Metrik

- Persentase relocalization berhasil dalam 60 detik.
- Median recovery time.
- P95 recovery time.
- Final position error.
- Final heading error.
- Jumlah kegagalan.

---

## 4. Ablation

### Tujuan

Menunjukkan manfaat global search dan multi-resolution apabila reviewer meminta pembuktian kontribusi setiap komponen.

### Data dan Varian

Gunakan minimal **10 rekaman representatif** dari trial yang sudah dilakukan. Tidak diperlukan eksperimen fisik tambahan.

| Varian | Konfigurasi |
|---|---|
| `local_only` | Local search only |
| `local_global` | Local search + existing global search |
| `single_resolution` | Single-resolution search |
| `multi_resolution` | Existing multi-resolution search |

### Prosedur

1. Pilih rekaman yang representatif dari kondisi nominal, occlusion, perubahan furnitur, dan kidnapped robot.
2. Putar ulang rekaman yang sama untuk setiap varian.
3. Pastikan input dan parameter selain komponen yang diuji tetap sama.
4. Simpan hasil setiap varian pada session dan trial yang sesuai.
5. Bandingkan seluruh varian menggunakan metrik yang sama.

### Metrik

- Success rate.
- Execution time.
- Position error.
- Recovery time.

---

## 5. Resource Komputasi

### Tujuan

Mengukur kelayakan komputasi existing stack pada tiga keadaan operasi yang relevan.

### Matriks Pengukuran

| ID keadaan | Keadaan | Durasi | Pengulangan |
|---|---|---:|---:|
| `idle` | Idle | 60 detik | 5 |
| `normal_tracking` | Normal tracking | 60 detik | 5 |
| `global_relocalization` | Global relocalization | 60 detik | 5 |
| **Total** |  |  | **15 pengukuran** |

### Metrik

- CPU usage.
- Peak RAM/RSS.
- Processing time per scan.
- Update rate.
- Binary size.

---

## Batas Scope Penelitian

Agar penelitian tetap fokus, item berikut tidak masuk eksperimen utama:

- Confusion matrix `VALID` / `DEGRADED` / `LOST`.
- Pelabelan interval oleh operator.
- Empat rute berbeda.
- Analisis ping, RSSI, dan performa jaringan secara terperinci.
- Raw scan streaming sebagai keadaan pengukuran tersendiri.
- Metrik navigation atau mission success.
- ArduPilot, AMCL, dan aplikasi tambahan.

Wi-Fi hanya dijelaskan sebagai media deployment dan pengambilan data, bukan sebagai kontribusi ilmiah.

## Checklist Kelengkapan Campaign

- [ ] 1 pilot selesai dan seluruh pipeline tervalidasi.
- [ ] 10 ground-truth placement selesai.
- [ ] 40 route trial selesai.
- [ ] 20 kidnapped-robot trial selesai.
- [ ] 15 pengukuran resource komputasi selesai.
- [ ] Minimal 10 rekaman selesai dianalisis untuk ablation.
- [ ] Semua trial telah melalui tahap analyze, review, dan finalize.
- [ ] Dataset dan hasil tersimpan dalam struktur output yang konsisten.

## Target Publikasi

Skema ini dirancang sederhana, fokus, dan realistis untuk jurnal Scopus Q3 bidang applied robotics atau automation. Jika hasil konsisten, ablation menunjukkan manfaat yang jelas, dan penulisan dilakukan dengan baik, peluang publikasi dapat diperkirakan sekitar **70–85%** pada jurnal yang scope-nya sesuai. Angka tersebut adalah estimasi, bukan jaminan penerimaan.
