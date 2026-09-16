import express from 'express'
import { createServer } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import dgram from 'node:dgram'
import { WebSocketServer, WebSocket } from 'ws'
import { MavlinkParser, decode } from './mavlink.js'

const RV_HOST=process.env.RV_HOST||'192.168.1.55'
const MAVLINK_PORT=Number(process.env.MAVLINK_PORT||5760)
const RTSP_URL=process.env.RTSP_URL||`rtsp://${RV_HOST}:8554/live`
const PORT=Number(process.env.PORT||3001)

type State={connected:boolean,lastUpdate:number,battery:number|null,voltage:number|null,current:number|null,lat:number|null,lon:number|null,altitude:number|null,relativeAltitude:number|null,groundSpeed:number|null,heading:number|null,climb:number|null,gpsFix:number|null,satellites:number|null,armed:boolean,customMode:number|null,landing:{raw:string,tag:string,inference:number|null,x:number|null,y:number|null,z:number|null,lastUpdate:number}|null}
const state:State={connected:false,lastUpdate:0,battery:null,voltage:null,current:null,lat:null,lon:null,altitude:null,relativeAltitude:null,groundSpeed:null,heading:null,climb:null,gpsFix:null,satellites:null,armed:false,customMode:null,landing:null}

const app=express();const server=createServer(app)
app.get('/api/config',(_req,res)=>res.json({rvHost:RV_HOST,mavlinkPort:MAVLINK_PORT,rtspUrl:RTSP_URL,statusPort:14551}))
app.get('/api/status',(_req,res)=>res.json(state))
app.use(express.static('dist'))
const telemetryWs=new WebSocketServer({server,path:'/telemetry'})
const videoWs=new WebSocketServer({server,path:'/video'})
function broadcastState(){const payload=JSON.stringify(state);for(const ws of telemetryWs.clients)if(ws.readyState===WebSocket.OPEN)ws.send(payload)}
setInterval(broadcastState,200)

const parser=new MavlinkParser()
parser.on('frame',frame=>{const msg=decode(frame);if(!msg)return;state.connected=true;state.lastUpdate=Date.now()
  if(msg.kind==='heartbeat'){state.armed=(msg.baseMode&128)!==0;state.customMode=msg.customMode}
  else if(msg.kind==='system'){state.voltage=msg.voltage;state.current=msg.current;state.battery=msg.battery}
  else if(msg.kind==='gps'){state.lat=msg.lat;state.lon=msg.lon;state.altitude=msg.altitude;state.gpsFix=msg.fix;state.satellites=msg.satellites}
  else if(msg.kind==='position'){state.lat=msg.lat;state.lon=msg.lon;state.altitude=msg.altitude;state.relativeAltitude=msg.relativeAltitude;state.heading=msg.heading}
  else if(msg.kind==='hud'){state.groundSpeed=msg.groundSpeed;state.heading=msg.heading;state.altitude=msg.altitude;state.climb=msg.climb}
})
let mavlink:net.Socket|undefined
function connectMavlink(){mavlink?.destroy();mavlink=net.createConnection({host:RV_HOST,port:MAVLINK_PORT},()=>{state.connected=true});mavlink.on('data',d=>parser.push(d));mavlink.on('error',()=>{});mavlink.on('close',()=>{state.connected=false;setTimeout(connectMavlink,1500)})}
connectMavlink();setInterval(()=>{if(Date.now()-state.lastUpdate>3000)state.connected=false},500)

const statusSocket=dgram.createSocket('udp4')
statusSocket.on('message',data=>{const raw=data.toString().trim();const m=/TAG=(\w+)\s+infer=([\d.]+)Hz\s+X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)/.exec(raw);state.landing={raw,tag:m?.[1]||'UNKNOWN',inference:m?Number(m[2]):null,x:m?Number(m[3]):null,y:m?Number(m[4]):null,z:m?Number(m[5]):null,lastUpdate:Date.now()}})
statusSocket.bind(14551,'0.0.0.0',()=>statusSocket.setBroadcast(true))

let ffmpeg:ChildProcessWithoutNullStreams|undefined
function startVideo(){if(ffmpeg)return;ffmpeg=spawn('ffmpeg',['-loglevel','warning','-rtsp_transport','tcp','-fflags','nobuffer','-flags','low_delay','-i',RTSP_URL,'-an','-c:v','copy','-f','mpegts','pipe:1'])
  ffmpeg.stdout.on('data',chunk=>{for(const ws of videoWs.clients)if(ws.readyState===WebSocket.OPEN)ws.send(chunk,{binary:true})})
  ffmpeg.stderr.on('data',d=>console.error(`[video] ${d.toString().trim()}`))
  ffmpeg.on('close',()=>{ffmpeg=undefined;if(videoWs.clients.size)setTimeout(startVideo,1500)})
}
videoWs.on('connection',ws=>{startVideo();ws.on('close',()=>{if(videoWs.clients.size===0&&ffmpeg){ffmpeg.kill('SIGTERM');ffmpeg=undefined}})})
server.listen(PORT,'0.0.0.0',()=>console.log(`Dashboard backend http://localhost:${PORT} | MAVLink ${RV_HOST}:${MAVLINK_PORT} | ${RTSP_URL}`))
