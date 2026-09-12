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
    pose=data['current_pose']; ch,sh=math.cos(a.heading),math.sin(a.heading)
    def ne(point):
        dx=point['x']-pose['x']; dy=point['y']-pose['y']
        return ch*dx+sh*dy, sh*dx-ch*dy
    latitude=lat/1e7; result=[]
    for point in data['waypoints']:
        north,east=ne(point)
        wp_lat=latitude+north/111319.49079327358
        wp_lon=lon/1e7+east/(111319.49079327358*math.cos(math.radians(latitude)))
        result.append((round(wp_lat*1e7),round(wp_lon*1e7)))
    target_component=1
    link.send(44,struct.pack('<HBBB',len(result),system,target_component,0),221)
    sent=set(); deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        msg,sysid,comp,payload=link.receive(deadline)
        if msg in (40,51) and len(payload)>=4:
            seq=struct.unpack_from('<H',payload,0)[0]
            if seq>=len(result): raise RuntimeError(f'ArduPilot requested invalid mission item {seq}')
            x,y=result[seq]
            item=struct.pack('<ffffiifHHBBBBBB',0,0.5,0,math.nan,x,y,0.0,seq,16,
                             system,target_component,6,1 if seq==0 else 0,1,0)
            link.send(73,item,38); sent.add(seq)
        elif msg==47 and len(payload)>=3:
            result_code=payload[2]
            if result_code!=0: raise RuntimeError(f'ArduPilot rejected mission: MAV_MISSION_RESULT={result_code}')
            if len(sent)!=len(result): raise RuntimeError('ArduPilot ACK arrived before all items were requested')
            print(json.dumps({'count':len(result),'target_system':system,'result':'accepted'})); return
    raise TimeoutError('timeout waiting for ArduPilot MISSION_ACK')

if __name__=='__main__': main()
