import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const mapDir = process.env.MAP_DIR || path.join(root, 'maps');
const mapName = process.env.MAP_NAME || 'ruang_utama';
const robotPort = Number(process.env.ROBOT_TCP_PORT || 42000);
const httpPort = Number(process.env.HTTP_PORT || 8080);
const offlineMs = Number(process.env.ROBOT_OFFLINE_MS || 1500);
const robots = new Map();
const MAGIC = 0x41475631, VERSION = 1, STATUS = 1, COMMAND = 2, ACK = 3;
let commandSequence = 0;
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients)
    if (client.readyState === WebSocket.OPEN) client.send(data);
}

function parseYamlMap() {
  const yaml = fs.readFileSync(path.join(mapDir, `${mapName}.yaml`), 'utf8');
  const number = (key) => Number(yaml.match(new RegExp(`^${key}:\\s*([^#\\n]+)`, 'm'))?.[1]);
  const origin = yaml.match(/^origin:\s*\[([^\]]+)\]/m)?.[1].split(',').map(Number);
  return { map_id: mapName, resolution: number('resolution'), origin: {
    x: origin?.[0] ?? 0, y: origin?.[1] ?? 0, yaw: origin?.[2] ?? 0 } };
}

function parsePgm() {
  const bytes = fs.readFileSync(path.join(mapDir, `${mapName}.pgm`));
  let offset = 0; const tokens = [];
  while (tokens.length < 4) {
    while (bytes[offset] === 32 || bytes[offset] === 10 || bytes[offset] === 13 || bytes[offset] === 9) offset++;
    if (bytes[offset] === 35) { while (bytes[offset++] !== 10); continue; }
    let token = ''; while (offset < bytes.length && ![32, 10, 13, 9].includes(bytes[offset])) token += String.fromCharCode(bytes[offset++]);
    tokens.push(token);
  }
  const [magic, widthText, heightText] = tokens;
  const width = Number(widthText), height = Number(heightText);
  while ([32, 10, 13, 9].includes(bytes[offset])) offset++;
  if (magic !== 'P5') throw new Error('Dashboard currently requires binary P5 PGM');
  return { width, height, pixels: bytes.subarray(offset, offset + width * height).toString('base64') };
}

app.get('/api/map', (_request, response) => {
  try { response.json({ ...parseYamlMap(), ...parsePgm() }); }
  catch (error) { response.status(500).json({ error: error.message }); }
});
app.get('/api/robots', (_request, response) => response.json([...robots.values()].map(r => r.status)));
app.post('/api/robots/:id/mission/:action', (request, response) => {
  const robot = robots.get(request.params.id);
  if (!robot) return response.status(404).json({ error: 'robot not connected' });
  const command = request.params.action === 'start' ? 'START_MISSION' :
    request.params.action === 'stop' ? 'STOP_MISSION' : null;
  if (!command) return response.status(400).json({ error: 'action must be start or stop' });
  const commandId = ++commandSequence;
  const frame = Buffer.alloc(24);
  frame.writeUInt32BE(MAGIC, 0); frame.writeUInt16BE(VERSION, 4); frame.writeUInt16BE(COMMAND, 6);
  frame.writeUInt32BE(8, 8); frame.writeUInt32BE(commandId, 12);
  frame.writeUInt8(command === 'START_MISSION' ? 1 : 2, 16);
  frame.writeUInt32BE(commandId, 20);
  robot.socket.write(frame);
  broadcast({ type: 'command_sent', robot_id: request.params.id, command });
  response.status(202).json({ accepted: true, command, command_id: commandId });
});

const frontend = path.resolve(here, '../../frontend/dist');
if (fs.existsSync(frontend)) {
  app.use(express.static(frontend));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, 'index.html')));
}

const robotServer = net.createServer(socket => {
  let incoming = Buffer.alloc(0), robotId;
  socket.setNoDelay(true); socket.setKeepAlive(true, 1000);
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 16) {
      if (incoming.readUInt32BE(0) !== MAGIC || incoming.readUInt16BE(4) !== VERSION) {
        incoming = incoming.subarray(1); continue;
      }
      const type = incoming.readUInt16BE(6), length = incoming.readUInt32BE(8), sequence = incoming.readUInt32BE(12);
      if (length > 1024) return socket.destroy();
      if (incoming.length < 16 + length) break;
      const payload = incoming.subarray(16, 16 + length);
      if (type === STATUS && length === 70) {
        robotId = payload.subarray(0, 32).toString('utf8').replace(/\0.*$/, '');
        const status = { type: 'robot_status', robot_id: robotId, seq: sequence,
          timestamp_ms: Number(payload.readBigUInt64BE(32)), pose: {
            x: payload.readFloatBE(40), y: payload.readFloatBE(44), yaw: payload.readFloatBE(48),
            score: payload.readFloatBE(52), valid: payload.readUInt8(64) === 1,
            mode: payload.readUInt8(65) === 1 ? 'global' : 'tracking' },
          power: { percent: payload.readFloatBE(56), voltage: payload.readFloatBE(60) },
          online: true, received_ms: Date.now() };
        robots.set(robotId, { status, socket }); broadcast({ type: 'robot_status', data: status });
      } else if (type === ACK && length === 8) {
        const command = payload.readUInt8(0) === 1 ? 'START_MISSION' : 'STOP_MISSION';
        broadcast({ type: 'command_ack', data: { robot_id: robotId, command,
          command_id: payload.readUInt32BE(4), sequence } });
      }
      incoming = incoming.subarray(16 + length);
    }
  });
  socket.on('close', () => { if (robotId && robots.get(robotId)?.socket === socket) {
    robots.get(robotId).status.online = false;
    broadcast({ type: 'robot_status', data: robots.get(robotId).status });
  }});
  socket.on('error', error => console.warn('Robot TCP:', error.message));
});
wss.on('connection', socket => socket.send(JSON.stringify({ type: 'snapshot',
  data: [...robots.values()].map(robot => robot.status) })));
setInterval(() => {
  const now = Date.now();
  for (const [id, robot] of robots) if (robot.status.online && now - robot.status.received_ms > offlineMs) {
    robot.status.online = false; broadcast({ type: 'robot_status', data: robot.status });
  }
}, 500);
robotServer.listen(robotPort, '0.0.0.0', () => console.log(`Robot TCP binary listening on :${robotPort}`));
server.listen(httpPort, '0.0.0.0', () => console.log(`Dashboard http://0.0.0.0:${httpPort}`));
