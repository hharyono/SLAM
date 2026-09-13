#!/usr/bin/env python3
"""Download ArduPilot waypoints and convert them to SLAM map XY."""
import argparse, json, math, struct, time
from upload_mavlink_mission import Link, measure_map_global_offset

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--host',required=True)
    parser.add_argument('--port',type=int,default=5761); parser.add_argument('--data',required=True)
    parser.add_argument('--heading',type=float,default=0); args=parser.parse_args()
    data=json.loads(args.data); link=Link(args.host,args.port)
    origin=data['origin']
    system,_component,north_offset,east_offset=measure_map_global_offset(link,origin)
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
    latitude=origin['latitude']; longitude=origin['longitude']
    # EKF3 yaw comes from ExternalNav, therefore map heading is a configured
    # constant rather than a value reconstructed from asynchronous live yaw.
    frame_heading=math.remainder(args.heading, 2*math.pi)
    ch,sh=math.cos(frame_heading),math.sin(frame_heading)
    points=[]
    for seq,(command,frame,x,y) in enumerate(items):
        # Mission item 0 is ArduPilot HOME, not a user-created waypoint.
        if seq==0: continue
        if command!=16 or frame not in (0,3,5,6,10,11): continue
        north=(x/1e7-latitude)*111319.49079327358-north_offset
        east=(y/1e7-longitude)*111319.49079327358*math.cos(math.radians(latitude))-east_offset
        points.append({'x':ch*north+sh*east,
                       'y':sh*north-ch*east})
    print(json.dumps({'count':len(points),'waypoints':points,'mission_items':count,
                      'alignment_offset_north':north_offset,
                      'alignment_offset_east':east_offset}))

if __name__=='__main__': main()
