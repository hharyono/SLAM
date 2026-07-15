import fs from 'node:fs';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

type Pose = { x:number; y:number; yaw:number; score:number; valid:boolean; mode:'global'|'tracking' };
type Power = { percent:number; voltage:number };
type RobotStatus = { type:'robot_status'; robot_id:string; seq:number; timestamp_ms:number;
  pose:Pose; power:Power; online:boolean; received_ms:number };
type RobotConnection = { status:RobotStatus; socket:Socket };
type MapMetadata = { map_id:string; resolution:number; origin:{x:number;y:number;yaw:number} };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const mapDir = process.env.MAP_DIR || path.join(root, 'maps');
const mapName = process.env.MAP_NAME || 'ruang_utama';
const robotPort = Number(process.env.ROBOT_TCP_PORT || 42000);
const httpPort = Number(process.env.HTTP_PORT || 8080);
const offlineMs = Number(process.env.ROBOT_OFFLINE_MS || 1500);
const MAGIC=0x41475631, VERSION=1, STATUS=1, COMMAND=2, ACK=3;
let commandSequence=0;
const robots = new Map<string,RobotConnection>();
const app=express(); app.use(express.json());
const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws'});

function broadcast(message:unknown):void { const data=JSON.stringify(message);
  for(const client of wss.clients) if(client.readyState===WebSocket.OPEN) client.send(data); }
function parseYamlMap():MapMetadata { const yaml=fs.readFileSync(path.join(mapDir,`${mapName}.yaml`),'utf8');
  const number=(key:string):number=>Number(yaml.match(new RegExp(`^${key}:\\s*([^#\\n]+)`,'m'))?.[1]);
  const origin=yaml.match(/^origin:\s*\[([^\]]+)\]/m)?.[1].split(',').map(Number);
  return {map_id:mapName,resolution:number('resolution'),origin:{x:origin?.[0]??0,y:origin?.[1]??0,yaw:origin?.[2]??0}}; }
function parsePgm():{width:number;height:number;pixels:string} { const bytes=fs.readFileSync(path.join(mapDir,`${mapName}.pgm`));
  let offset=0; const tokens:string[]=[];
  while(tokens.length<4){while([32,10,13,9].includes(bytes[offset]!))offset++;
    if(bytes[offset]===35){while(bytes[offset++]!==10);continue;} let token='';
    while(offset<bytes.length&&![32,10,13,9].includes(bytes[offset]!))token+=String.fromCharCode(bytes[offset++]!);tokens.push(token);}
  const [magic,widthText,heightText]=tokens; const width=Number(widthText),height=Number(heightText);
  while([32,10,13,9].includes(bytes[offset]!))offset++; if(magic!=='P5')throw new Error('Dashboard requires binary P5 PGM');
  return {width,height,pixels:bytes.subarray(offset,offset+width*height).toString('base64')}; }

app.get('/api/map',(_req,res)=>{try{res.json({...parseYamlMap(),...parsePgm()});}catch(error){res.status(500).json({error:(error as Error).message});}});
app.get('/api/robots',(_req,res)=>res.json([...robots.values()].map(r=>r.status)));
app.post('/api/robots/:id/mission/:action',(req,res)=>{const robot=robots.get(req.params.id);
  if(!robot)return res.status(404).json({error:'robot not connected'});
  const command=req.params.action==='start'?'START_MISSION':req.params.action==='stop'?'STOP_MISSION':null;
  if(!command)return res.status(400).json({error:'action must be start or stop'});
  const commandId=++commandSequence,frame=Buffer.alloc(24); frame.writeUInt32BE(MAGIC,0);frame.writeUInt16BE(VERSION,4);
  frame.writeUInt16BE(COMMAND,6);frame.writeUInt32BE(8,8);frame.writeUInt32BE(commandId,12);
  frame.writeUInt8(command==='START_MISSION'?1:2,16);frame.writeUInt32BE(commandId,20);robot.socket.write(frame);
  broadcast({type:'command_sent',robot_id:req.params.id,command});return res.status(202).json({accepted:true,command,command_id:commandId});});

const frontend=path.resolve(here,'../../frontend/dist');
if(fs.existsSync(frontend)){app.use(express.static(frontend));app.get(/.*/,(_req,res)=>res.sendFile(path.join(frontend,'index.html')));}

const robotServer=net.createServer(socket=>{let incoming=Buffer.alloc(0),robotId:string|undefined;
  socket.setNoDelay(true);socket.setKeepAlive(true,1000);
  socket.on('data',(chunk:Buffer)=>{incoming=Buffer.concat([incoming,chunk]);while(incoming.length>=16){
    if(incoming.readUInt32BE(0)!==MAGIC||incoming.readUInt16BE(4)!==VERSION){incoming=incoming.subarray(1);continue;}
    const type=incoming.readUInt16BE(6),length=incoming.readUInt32BE(8),sequence=incoming.readUInt32BE(12);
    if(length>1024)return socket.destroy();if(incoming.length<16+length)break;const payload=incoming.subarray(16,16+length);
    if(type===STATUS&&length===70){robotId=payload.subarray(0,32).toString('utf8').replace(/\0.*$/,'');
      const status:RobotStatus={type:'robot_status',robot_id:robotId,seq:sequence,timestamp_ms:Number(payload.readBigUInt64BE(32)),
        pose:{x:payload.readFloatBE(40),y:payload.readFloatBE(44),yaw:payload.readFloatBE(48),score:payload.readFloatBE(52),
          valid:payload.readUInt8(64)===1,mode:payload.readUInt8(65)===1?'global':'tracking'},
        power:{percent:payload.readFloatBE(56),voltage:payload.readFloatBE(60)},online:true,received_ms:Date.now()};
      robots.set(robotId,{status,socket});broadcast({type:'robot_status',data:status});
    }else if(type===ACK&&length===8){broadcast({type:'command_ack',data:{robot_id:robotId,
      command:payload.readUInt8(0)===1?'START_MISSION':'STOP_MISSION',command_id:payload.readUInt32BE(4),sequence}});}
    incoming=incoming.subarray(16+length);}});
  socket.on('close',()=>{if(robotId&&robots.get(robotId)?.socket===socket){const robot=robots.get(robotId)!;
    robot.status.online=false;broadcast({type:'robot_status',data:robot.status});}});
  socket.on('error',(error:Error)=>console.warn('Robot TCP:',error.message));});
wss.on('connection',socket=>socket.send(JSON.stringify({type:'snapshot',data:[...robots.values()].map(r=>r.status)})));
setInterval(()=>{const now=Date.now();for(const robot of robots.values())if(robot.status.online&&now-robot.status.received_ms>offlineMs){
  robot.status.online=false;broadcast({type:'robot_status',data:robot.status});}},500);
robotServer.listen(robotPort,'0.0.0.0',()=>console.log(`Robot TCP binary listening on :${robotPort}`));
server.listen(httpPort,'0.0.0.0',()=>console.log(`Dashboard http://0.0.0.0:${httpPort}`));
