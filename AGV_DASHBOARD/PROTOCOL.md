# AGV TCP Binary Protocol v1

Semua integer dan IEEE-754 float dikirim big-endian. Robot membuka satu koneksi
TCP persisten ke backend pada port `42000`; status, command, dan ACK memakai
koneksi yang sama.

Header setiap frame (16 byte):

| Offset | Type | Isi |
|---:|---|---|
| 0 | u32 | Magic `0x41475631` (`AGV1`) |
| 4 | u16 | Version `1` |
| 6 | u16 | Type: status=1, command=2, ACK=3, map=4, map ACK=5 |
| 8 | u32 | Payload length |
| 12 | u32 | Sequence/command ID |

Status payload (70 byte): `robot_id[32]`, timestamp u64, x/y/yaw/score/power
percent/voltage float32, valid u8, mode u8 (`0=tracking`, `1=global`),
mission_running u8, reserved[3].

Command dan ACK payload (8 byte): command u8 (`1=start`, `2=stop`), reserved[3],
command ID u32. Batas payload parser adalah 1024 byte untuk mencegah frame rusak
menghabiskan memori.

Map payload terdiri dari transfer ID u32, nama map UTF-8 dalam field 32 byte,
kemudian seluruh isi `map.bin`. Board menulisnya sebagai file `.new`, memeriksa
magic, ukuran, dan CRC melalui parser localizer, lalu mengganti map aktif secara
atomik. Map lama disimpan sebagai `.bak`. Map ACK berisi transfer ID u32,
success u8, dan reserved[3]. Batas payload map adalah 1 MiB.

Map yang baru dipasang akan dibaca pada start `localize_uart` berikutnya. Jadi
restart localizer diperlukan bila proses sedang berjalan saat transfer.

## ScanFrame TCP 42010

Board membuka koneksi terpisah ke ROS bridge menggunakan magic `SCN1`. Header
16 byte berisi magic, version u16, type u16, payload length u32, dan sequence
u32. Payload scan berisi timestamp u64, tujuh float metadata LaserScan, jumlah
titik u32, lalu setiap titik sebagai angle/range/intensity float32.

YDLidar SDK tetap berjalan pada board untuk decoding UART dan checksum. Backend
tidak menjalankan `ydlidar_ros2_driver_node`; `scan_tcp_bridge_node` mengubah
ScanFrame menjadi topic ROS `/scan` reliable.

## Live map TCP 42020

ROS bridge berlangganan `/map` dan mengirim occupancy grid lokal ke Node backend
dengan magic `MAP1`. Port ini hanya listen pada `127.0.0.1`. Backend membalik
sumbu baris OccupancyGrid menjadi koordinat gambar dan mengirim `mapping_map`
ke frontend melalui WebSocket.
