#!/usr/bin/env python3
"""Set and verify ArduPilot EKF origin over the MAVLink 2 upload port."""
import argparse, json, math, struct, time
from upload_mavlink_mission import Link

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True); parser.add_argument('--port', type=int, default=5761)
    parser.add_argument('--latitude', type=float, required=True)
    parser.add_argument('--longitude', type=float, required=True)
    parser.add_argument('--altitude', type=float, default=0)
    args = parser.parse_args()
    if not (-90 <= args.latitude <= 90 and -180 <= args.longitude <= 180 and
            all(map(math.isfinite, (args.latitude, args.longitude, args.altitude)))):
        raise ValueError('invalid origin coordinates')
    link = Link(args.host, args.port); deadline = time.monotonic() + 8; system = None
    while time.monotonic() < deadline:
        msg, sysid, _component, _payload = link.receive(deadline)
        if msg == 0 and sysid not in (0, 255): system = sysid; break
    if system is None: raise RuntimeError('ArduPilot heartbeat not received')
    lat = round(args.latitude * 1e7); lon = round(args.longitude * 1e7)
    alt = round(args.altitude * 1000)
    link.send(48, struct.pack('<iiiB', lat, lon, alt, system), 41)
    deadline = time.monotonic() + 8; global_position = None
    try:
        while time.monotonic() < deadline:
            msg, sysid, _component, payload = link.receive(deadline)
            if msg == 49 and sysid == system and len(payload) >= 12:
                got_lat, got_lon, got_alt = struct.unpack_from('<iii', payload)
                if abs(got_lat-lat) <= 1 and abs(got_lon-lon) <= 1:
                    print(json.dumps({'latitude': got_lat/1e7, 'longitude': got_lon/1e7,
                                      'altitude': got_alt/1000, 'result': 'verified_origin'}))
                    return
            if msg == 33 and sysid == system and len(payload) >= 12:
                global_position = struct.unpack_from('<ii', payload, 4)
    except TimeoutError:
        pass
    if global_position and global_position != (0, 0):
        current_lat, current_lon = global_position[0]/1e7, global_position[1]/1e7
        north = (current_lat-args.latitude)*111319.49079327358
        east = (current_lon-args.longitude)*111319.49079327358*math.cos(math.radians(args.latitude))
        if math.hypot(north,east) <= 500:
            print(json.dumps({'latitude': args.latitude, 'longitude': args.longitude,
                              'altitude': args.altitude, 'result': 'verified_global_position'}))
            return
    raise TimeoutError('EKF origin was not confirmed; disarm and reboot ArduPilot before changing an existing origin')

if __name__ == '__main__': main()
