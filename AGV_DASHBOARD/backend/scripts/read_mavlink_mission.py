#!/usr/bin/env python3
"""Download ArduPilot waypoints and convert them to SLAM map XY."""
import argparse, json, math, struct, time
from upload_mavlink_mission import Link

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--host',required=True)
    parser.add_argument('--port',type=int,default=5761); parser.add_argument('--data',required=True)
    parser.add_argument('--heading',type=float,default=0); args=parser.parse_args()
    data=json.loads(args.data); link=Link(args.host,args.port); deadline=time.monotonic()+8
    system=None; lat=lon=None
    while time.monotonic()<deadline and (system is None or lat is None):
        msg,sysid,_comp,payload=link.receive(deadline)
        if msg==0 and sysid not in (0,255): system=sysid
        elif msg==33 and len(payload)>=12:
            lat,lon=struct.unpack_from('<ii',payload,4)
            if system is None: system=sysid
    if system is None or lat is None: raise RuntimeError('ArduPilot heartbeat/global position not received')
    if lat==0 and lon==0: raise RuntimeError('ArduPilot EKF origin is not set (global position is 0,0)')
    target_component=1; link.send(43,bytes([system,target_component,0]),132)
    deadline=time.monotonic()+8; count=None
    while time.monotonic()<deadline:
        msg,_sysid,_comp,payload=link.receive(deadline)
        if msg==44 and len(payload)>=2:
            count=struct.unpack_from('<H',payload)[0]; break
    if count is None: raise TimeoutError('MISSION_COUNT not received')
    if count>100: raise RuntimeError(f'mission contains too many items: {count}')
    items=[]
    for seq in range(count):
        for attempt in range(3):
            link.send(51,struct.pack('<HBBB',seq,system,target_component,0),196)
            item_deadline=time.monotonic()+3
            try:
                while time.monotonic()<item_deadline:
                    msg,_sysid,_comp,payload=link.receive(item_deadline)
                    if msg==73 and len(payload)>=37 and struct.unpack_from('<H',payload,28)[0]==seq:
                        command=struct.unpack_from('<H',payload,30)[0]; frame=payload[34]
                        x,y=struct.unpack_from('<ii',payload,16)
                        items.append((command,frame,x,y)); break
                else: raise TimeoutError()
                break
            except TimeoutError:
                if attempt==2: raise TimeoutError(f'mission item {seq} not received')
    link.send(47,bytes([system,target_component,0,0]),153)
    origin=data['origin']; latitude=origin['latitude']; longitude=origin['longitude']
    ch,sh=math.cos(args.heading),math.sin(args.heading)
    points=[]
    for seq,(command,frame,x,y) in enumerate(items):
        # Mission item 0 is ArduPilot HOME, not a user-created waypoint.
        if seq==0: continue
        if command!=16 or frame not in (0,3,5,6,10,11): continue
        north=(x/1e7-latitude)*111319.49079327358
        east=(y/1e7-longitude)*111319.49079327358*math.cos(math.radians(latitude))
        points.append({'x':ch*north+sh*east, 'y':sh*north-ch*east})
    print(json.dumps({'count':len(points),'waypoints':points,'mission_items':count}))

if __name__=='__main__': main()
