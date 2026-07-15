# AGV TCP Binary Protocol v1

Semua integer dan IEEE-754 float dikirim big-endian. Robot membuka satu koneksi
TCP persisten ke backend pada port `42000`; status, command, dan ACK memakai
koneksi yang sama.

Header setiap frame (16 byte):

| Offset | Type | Isi |
|---:|---|---|
| 0 | u32 | Magic `0x41475631` (`AGV1`) |
| 4 | u16 | Version `1` |
| 6 | u16 | Type: status=1, command=2, ACK=3 |
| 8 | u32 | Payload length |
| 12 | u32 | Sequence/command ID |

Status payload (70 byte): `robot_id[32]`, timestamp u64, x/y/yaw/score/power
percent/voltage float32, valid u8, mode u8 (`0=tracking`, `1=global`), reserved[4].

Command dan ACK payload (8 byte): command u8 (`1=start`, `2=stop`), reserved[3],
command ID u32. Batas payload parser adalah 1024 byte untuk mencegah frame rusak
menghabiskan memori.
