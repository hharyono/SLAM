#!/usr/bin/env python3
"""Decode Luckfox ExternalNav on a PC; no heartbeat is required."""
import argparse
import time
from pymavlink import mavutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("port", help="USB UART device, e.g. /dev/ttyUSB0 or COM5")
parser.add_argument("--baud", type=int, default=115200)
args = parser.parse_args()
connection = mavutil.mavlink_connection(args.port, baud=args.baud, dialect="common")
last = None
try:
    while True:
        msg = connection.recv_match(type="VISION_POSITION_ESTIMATE", blocking=True, timeout=2)
        if msg is None:
            print("No position for 2 s (check tracking, mission START, wiring and baud)", flush=True)
            last = None
            continue
        now = time.monotonic()
        rate = 1 / (now - last) if last is not None and now > last else 0
        last = now
        version = 2 if msg.get_msgbuf()[0] == 0xFD else 1
        print(f"v{version} sys={msg.get_srcSystem()} comp={msg.get_srcComponent()} "
              f"N={msg.x:.3f} E={msg.y:.3f} D={msg.z:.3f} yaw={msg.yaw:.3f} "
              f"reset={getattr(msg, 'reset_counter', 0)} usec={msg.usec} rate={rate:.1f}Hz",
              flush=True)
except KeyboardInterrupt:
    pass
finally:
    connection.close()
