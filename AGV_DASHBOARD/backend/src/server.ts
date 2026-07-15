import fs from 'node:fs';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

type Pose = {
  x: number;
  y: number;
  yaw: number;
  score: number;
  valid: boolean;
  mode: 'global' | 'tracking';
};
type Power = {
  percent: number;
  voltage: number;
};
type RobotStatus = {
  type: 'robot_status';
  robot_id: string;
  seq: number;
  timestamp_ms: number;
  pose: Pose;
  power: Power;
  mission_running: boolean;
  online: boolean;
  received_ms: number;
};
type RobotConnection = {
  status: RobotStatus;
  socket: Socket;
};
type MapMetadata = {
  map_id: string;
  resolution: number;
  origin: { x: number; y: number; yaw: number };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const mapDir = process.env.MAP_DIR || path.join(root, 'maps');
const mapName = process.env.MAP_NAME || 'ruang_utama';
const robotPort = Number(process.env.ROBOT_TCP_PORT || 42000);
const httpPort = Number(process.env.HTTP_PORT || 8080);
const offlineMs = Number(process.env.ROBOT_OFFLINE_MS || 1500);
const PROTOCOL_MAGIC = 0x41475631; // ASCII: AGV1
const PROTOCOL_VERSION = 1;
const FRAME_HEADER_BYTES = 16;
const MAX_PAYLOAD_BYTES = 1024;
const STATUS_PAYLOAD_BYTES = 70;
const COMMAND_PAYLOAD_BYTES = 8;

enum FrameType {
  Status = 1,
  Command = 2,
  Acknowledgement = 3,
}

enum MissionCommand {
  Start = 1,
  Stop = 2,
}
let commandSequence = 0;
const robots = new Map<string, RobotConnection>();
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastToDashboards(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
function parseYamlMap(): MapMetadata {
  const yaml = fs.readFileSync(path.join(mapDir, `${mapName}.yaml`), 'utf8');
  const number = (key: string): number =>
    Number(yaml.match(new RegExp(`^${key}:\\s*([^#\\n]+)`, 'm'))?.[1]);
  const origin = yaml
    .match(/^origin:\s*\[([^\]]+)\]/m)?.[1]
    .split(',')
    .map(Number);
  return {
    map_id: mapName,
    resolution: number('resolution'),
    origin: { x: origin?.[0] ?? 0, y: origin?.[1] ?? 0, yaw: origin?.[2] ?? 0 },
  };
}
function parsePgm(): { width: number; height: number; pixels: string } {
  const bytes = fs.readFileSync(path.join(mapDir, `${mapName}.pgm`));
  let offset = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while ([32, 10, 13, 9].includes(bytes[offset]!)) offset++;
    if (bytes[offset] === 35) {
      while (bytes[offset++] !== 10);
      continue;
    }
    let token = '';
    while (offset < bytes.length && ![32, 10, 13, 9].includes(bytes[offset]!))
      token += String.fromCharCode(bytes[offset++]!);
    tokens.push(token);
  }
  const [magic, widthText, heightText] = tokens;
  const width = Number(widthText);
  const height = Number(heightText);
  while ([32, 10, 13, 9].includes(bytes[offset]!)) offset++;
  if (magic !== 'P5') throw new Error('Dashboard requires binary P5 PGM');
  return {
    width,
    height,
    pixels: bytes.subarray(offset, offset + width * height).toString('base64'),
  };
}

function createMissionFrame(command: MissionCommand, commandId: number): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + COMMAND_PAYLOAD_BYTES);

  frame.writeUInt32BE(PROTOCOL_MAGIC, 0);
  frame.writeUInt16BE(PROTOCOL_VERSION, 4);
  frame.writeUInt16BE(FrameType.Command, 6);
  frame.writeUInt32BE(COMMAND_PAYLOAD_BYTES, 8);
  frame.writeUInt32BE(commandId, 12);

  frame.writeUInt8(command, 16);
  frame.writeUInt32BE(commandId, 20);
  return frame;
}

function decodeRobotStatus(payload: Buffer, sequence: number): RobotStatus {
  const robotId = payload.subarray(0, 32).toString('utf8').replace(/\0.*$/, '');

  return {
    type: 'robot_status',
    robot_id: robotId,
    seq: sequence,
    timestamp_ms: Number(payload.readBigUInt64BE(32)),
    pose: {
      x: payload.readFloatBE(40),
      y: payload.readFloatBE(44),
      yaw: payload.readFloatBE(48),
      score: payload.readFloatBE(52),
      valid: payload.readUInt8(64) === 1,
      mode: payload.readUInt8(65) === 1 ? 'global' : 'tracking',
    },
    power: {
      percent: payload.readFloatBE(56),
      voltage: payload.readFloatBE(60),
    },
    mission_running: payload.readUInt8(66) === 1,
    online: true,
    received_ms: Date.now(),
  };
}

app.get('/api/map', (_req, res) => {
  try {
    res.json({ ...parseYamlMap(), ...parsePgm() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
app.get('/api/robots', (_req, res) => res.json([...robots.values()].map((r) => r.status)));
app.post('/api/robots/:id/mission/:action', (req, res) => {
  const robot = robots.get(req.params.id);
  if (!robot) return res.status(404).json({ error: 'robot not connected' });
  const command = req.params.action === 'start' ? MissionCommand.Start : MissionCommand.Stop;
  if (req.params.action !== 'start' && req.params.action !== 'stop') {
    return res.status(400).json({ error: 'action must be start or stop' });
  }

  const commandName = command === MissionCommand.Start ? 'START_MISSION' : 'STOP_MISSION';
  const commandId = ++commandSequence;
  const frame = createMissionFrame(command, commandId);
  robot.socket.write(frame);
  broadcastToDashboards({ type: 'command_sent', robot_id: req.params.id, command: commandName });
  return res.status(202).json({ accepted: true, command: commandName, command_id: commandId });
});

const frontend = path.resolve(here, '../../frontend/dist');
if (fs.existsSync(frontend)) {
  app.use(express.static(frontend));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(frontend, 'index.html')));
}

const robotServer = net.createServer((socket) => {
  let incoming = Buffer.alloc(0);
  let robotId: string | undefined;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
  socket.on('data', (chunk: Buffer) => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= FRAME_HEADER_BYTES) {
      const hasValidHeader =
        incoming.readUInt32BE(0) === PROTOCOL_MAGIC &&
        incoming.readUInt16BE(4) === PROTOCOL_VERSION;

      if (!hasValidHeader) {
        incoming = incoming.subarray(1);
        continue;
      }
      const type = incoming.readUInt16BE(6);
      const payloadLength = incoming.readUInt32BE(8);
      const sequence = incoming.readUInt32BE(12);
      if (payloadLength > MAX_PAYLOAD_BYTES) return socket.destroy();
      if (incoming.length < FRAME_HEADER_BYTES + payloadLength) break;

      const payload = incoming.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength);
      if (type === FrameType.Status && payloadLength === STATUS_PAYLOAD_BYTES) {
        const status = decodeRobotStatus(payload, sequence);
        robotId = status.robot_id;
        robots.set(robotId, { status, socket });
        broadcastToDashboards({ type: 'robot_status', data: status });
      } else if (type === FrameType.Acknowledgement && payloadLength === COMMAND_PAYLOAD_BYTES) {
        broadcastToDashboards({
          type: 'command_ack',
          data: {
            robot_id: robotId,
            command:
              payload.readUInt8(0) === MissionCommand.Start ? 'START_MISSION' : 'STOP_MISSION',
            command_id: payload.readUInt32BE(4),
            sequence,
          },
        });
      }
      incoming = incoming.subarray(FRAME_HEADER_BYTES + payloadLength);
    }
  });
  socket.on('close', () => {
    if (robotId && robots.get(robotId)?.socket === socket) {
      const robot = robots.get(robotId)!;
      robot.status.online = false;
      broadcastToDashboards({ type: 'robot_status', data: robot.status });
    }
  });
  socket.on('error', (error: Error) => console.warn('Robot TCP:', error.message));
});
wss.on('connection', (socket) =>
  socket.send(
    JSON.stringify({ type: 'snapshot', data: [...robots.values()].map((r) => r.status) }),
  ),
);
setInterval(() => {
  const now = Date.now();
  for (const robot of robots.values())
    if (robot.status.online && now - robot.status.received_ms > offlineMs) {
      robot.status.online = false;
      broadcastToDashboards({ type: 'robot_status', data: robot.status });
    }
}, 500);
robotServer.listen(robotPort, '0.0.0.0', () =>
  console.log(`Robot TCP binary listening on :${robotPort}`),
);
server.listen(httpPort, '0.0.0.0', () => console.log(`Dashboard http://0.0.0.0:${httpPort}`));
