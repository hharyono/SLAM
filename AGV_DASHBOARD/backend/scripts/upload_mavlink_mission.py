#!/usr/bin/env python3
"""Upload clicked SLAM points as an ArduPilot AUTO mission over MAVLink 2."""
import argparse, json, math, socket, struct, time

EXTRA = {0: 50, 33: 104, 44: 221, 47: 153, 51: 196, 73: 38}

def crc(data, extra):
    value = 0xffff
    for byte in data + bytes([extra]):
        tmp = byte ^ (value & 0xff); tmp ^= (tmp << 4) & 0xff
        value = ((value >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
    return value & 0xffff

class Link:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), 5)
        self.sock.settimeout(.5); self.buffer = bytearray(); self.sequence = 0
    def send(self, msgid, payload, extra):
        while payload and payload[-1] == 0: payload = payload[:-1]
        header = bytes([len(payload), 0, 0, self.sequence, 250, 190,
                        msgid & 255, (msgid >> 8) & 255, (msgid >> 16) & 255])
        self.sequence = (self.sequence + 1) & 255
        checksum = crc(header + payload, extra)
        self.sock.sendall(b'\xfd' + header + payload + struct.pack('<H', checksum))
    def receive(self, deadline):
        while time.monotonic() < deadline:
            while self.buffer and self.buffer[0] != 0xfd: del self.buffer[0]
            if len(self.buffer) >= 10:
                length, incompat = self.buffer[1], self.buffer[2]
                total = 12 + length + (13 if incompat & 1 else 0)
                if len(self.buffer) >= total:
                    frame = bytes(self.buffer[:total]); del self.buffer[:total]
                    return frame[7] | frame[8] << 8 | frame[9] << 16, frame[5], frame[6], frame[10:10+length]
            try: self.buffer.extend(self.sock.recv(4096))
            except socket.timeout: pass
        raise TimeoutError('timeout waiting for ArduPilot MAVLink response')

def main():
    p=argparse.ArgumentParser(); p.add_argument('--host', required=True); p.add_argument('--port',type=int,default=5760)
    p.add_argument('--data',required=True); p.add_argument('--heading',type=float,default=0); a=p.parse_args()
    data=json.loads(a.data); link=Link(a.host,a.port); deadline=time.monotonic()+8
    system=component=None; lat=lon=None
    while time.monotonic()<deadline and (system is None or lat is None):
        msg,sysid,comp,payload=link.receive(deadline)
        if msg==0 and sysid != 255: system,component=sysid,comp
        elif msg==33 and len(payload)>=12:
            lat,lon=struct.unpack_from('<ii',payload,4)
            if system is None: system,component=sysid,comp
    if system is None or lat is None: raise RuntimeError('ArduPilot heartbeat/global position not received')
    if lat == 0 and lon == 0:
        raise RuntimeError('ArduPilot EKF origin is not set (GLOBAL_POSITION_INT is 0,0)')
    origin=data['origin']; ch,sh=math.cos(a.heading),math.sin(a.heading)
    def ne(point):
        dx=point['x']; dy=point['y']
        return ch*dx+sh*dy, sh*dx-ch*dy
    latitude=origin['latitude']; longitude=origin['longitude']; result=[]
    for point in data['waypoints']:
        north,east=ne(point)
        wp_lat=latitude+north/111319.49079327358
        wp_lon=longitude+east/(111319.49079327358*math.cos(math.radians(latitude)))
        result.append((round(wp_lat*1e7),round(wp_lon*1e7)))
    # ArduPilot reserves mission sequence 0 for HOME and may replace its
    # coordinates with the vehicle position. Keep clicked waypoints at seq 1..
    # so the first user waypoint is not silently replaced by HOME.
    mission_items=[(lat,lon), *result]
    target_component=1
    mission_count=struct.pack('<HBBB',len(mission_items),system,target_component,0)
    link.send(44,mission_count,221)
    sent=set(); requests=[]; deadline=time.monotonic()+35; last_progress=time.monotonic()
    while time.monotonic()<deadline:
        if len(sent)==len(mission_items) and time.monotonic()-last_progress>=2:
            print(json.dumps({'count':len(result),'target_system':system,
                              'result':'mavlink2_int_items_complete'})); return
        try:
            msg,sysid,comp,payload=link.receive(min(deadline,time.monotonic()+2))
        except TimeoutError:
            # ArduPilot 4.5 can emit a legacy MISSION_REQUEST immediately, then
            # retry the same sequence as MISSION_REQUEST_INT after about 1 s.
            # Keep the transaction alive so that retry is not reset to seq 0.
            continue
        if msg in (40,51) and len(payload)>=4:
            seq=struct.unpack_from('<H',payload,0)[0]
            requests.append({'message':msg,'sequence':seq})
            if seq>=len(mission_items): raise RuntimeError(f'ArduPilot requested invalid mission item {seq}')
            x,y=mission_items[seq]
            # Rover 4.5.6 queues legacy MISSION_REQUEST (40) between items even
            # on a MAVLink 2 link. Its common item handler accepts the precise
            # MISSION_ITEM_INT response. Always respond with ID 73 so global
            # coordinates never pass through float32 degrees.
            item=struct.pack('<ffffiifHHBBBBBB',0,0.5,0,math.nan,x,y,0.0,seq,16,
                             system,target_component,6,1 if seq==0 else 0,1,0)
            link.send(73,item,38)
            sent.add(seq); last_progress=time.monotonic()
        elif msg==47 and len(payload)>=3:
            result_code=payload[2]
            if result_code!=0: raise RuntimeError(f'ArduPilot rejected mission: MAV_MISSION_RESULT={result_code}')
            if len(sent)!=len(mission_items): raise RuntimeError('ArduPilot ACK arrived before all items were requested')
            print(json.dumps({'count':len(result),'target_system':system,'result':'accepted'})); return
    raise TimeoutError('timeout waiting for MAVLink 2 mission transfer; '
                       f'INT items sent={sorted(sent)}, requests={requests[-16:]}')

if __name__=='__main__': main()
