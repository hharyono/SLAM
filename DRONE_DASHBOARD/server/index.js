import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { MavlinkParser, decode } from './mavlink.js';
const RV_HOST = process.env.RV_HOST || '192.168.1.55';
const MAVLINK_PORT = Number(process.env.MAVLINK_PORT || 5760);
const RTSP_URL = process.env.RTSP_URL || `rtsp://${RV_HOST}:8554/live`;
const PORT = Number(process.env.PORT || 3001);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const state = { connected: false, lastUpdate: 0, battery: null, voltage: null, current: null, lat: null, lon: null, altitude: null, relativeAltitude: null, groundSpeed: null, heading: null, climb: null, gpsFix: null, satellites: null, armed: false, customMode: null, preclandHealthy: false, precland: { status: 'UNKNOWN', message: 'Waiting for ArduPilot PrecLand status', lastUpdate: 0 }, preclandEvents: [], landing: null };
const app = express();
const server = createServer(app);
app.get('/api/config', (_req, res) => res.json({ rvHost: RV_HOST, mavlinkPort: MAVLINK_PORT, rtspUrl: RTSP_URL, statusPort: 14551 }));
app.get('/api/status', (_req, res) => res.json(state));
app.use(express.static('dist'));
const telemetryWs = new WebSocketServer({ noServer: true });
const videoWs = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    const target = path === '/telemetry' ? telemetryWs : path === '/video' ? videoWs : undefined;
    if (!target) {
        socket.destroy();
        return;
    }
    target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request));
});
function broadcastState() { const payload = JSON.stringify(state); for (const ws of telemetryWs.clients)
    if (ws.readyState === WebSocket.OPEN)
        ws.send(payload); }
setInterval(broadcastState, 200);
const parser = new MavlinkParser();
parser.on('frame', frame => {
    const msg = decode(frame);
    if (!msg)
        return;
    state.connected = true;
    state.lastUpdate = Date.now();
    if (msg.kind === 'heartbeat') {
        state.armed = (msg.baseMode & 128) !== 0;
        state.customMode = msg.customMode;
    }
    else if (msg.kind === 'system') {
        state.voltage = msg.voltage;
        state.current = msg.current;
        state.battery = msg.battery;
        const visionPosition = 128;
        state.preclandHealthy = (msg.sensorsPresent & visionPosition) !== 0 && (msg.sensorsEnabled & visionPosition) !== 0 && (msg.sensorsHealth & visionPosition) !== 0;
    }
    else if (msg.kind === 'gps') {
        state.lat = msg.lat;
        state.lon = msg.lon;
        state.altitude = msg.altitude;
        state.gpsFix = msg.fix;
        state.satellites = msg.satellites;
    }
    else if (msg.kind === 'position') {
        state.lat = msg.lat;
        state.lon = msg.lon;
        state.altitude = msg.altitude;
        state.relativeAltitude = msg.relativeAltitude;
        state.heading = msg.heading;
    }
    else if (msg.kind === 'hud') {
        state.groundSpeed = msg.groundSpeed;
        state.heading = msg.heading;
        state.altitude = msg.altitude;
        state.climb = msg.climb;
    }
    else if (msg.kind === 'statusText' && /PrecLand:/i.test(msg.text)) {
        let status;
        if (/Target Found/i.test(msg.text))
            status = 'INITIALIZING';
        else if (/Init Complete/i.test(msg.text))
            status = 'TARGET_ACQUIRED';
        else if (/Target Lost/i.test(msg.text))
            status = 'TARGET_LOST';
        else if (/Init Failed/i.test(msg.text))
            status = 'INIT_FAILED';
        if (status) {
            const time = Date.now();
            state.precland = { status, message: msg.text, lastUpdate: time };
            state.preclandEvents = [...state.preclandEvents.slice(-99), { time, text: msg.text, status }];
            console.log(`[ArduPilot] ${msg.text}`);
        }
    }
});
let mavlink;
function connectMavlink() { mavlink?.destroy(); mavlink = net.createConnection({ host: RV_HOST, port: MAVLINK_PORT }, () => { state.connected = true; }); mavlink.on('data', d => parser.push(d)); mavlink.on('error', () => { }); mavlink.on('close', () => { state.connected = false; setTimeout(connectMavlink, 1500); }); }
connectMavlink();
setInterval(() => { if (Date.now() - state.lastUpdate > 3000)
    state.connected = false; }, 500);
function updateLanding(raw) { const m = /TAG=(\w+)\s+infer=([\d.]+)Hz\s+X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)\s+MAV=(\w+)/.exec(raw); state.landing = { raw, tag: m?.[1] || 'UNKNOWN', inference: m ? Number(m[2]) : null, x: m ? Number(m[3]) : null, y: m ? Number(m[4]) : null, z: m ? Number(m[5]) : null, mavValid: m?.[6] === 'VALID', lastUpdate: Date.now() }; }
let statusClient, statusBuffer = '';
function connectLandingStatus() { statusClient?.destroy(); statusClient = net.createConnection({ host: RV_HOST, port: 14551 }); statusClient.on('data', data => { statusBuffer += data.toString(); const lines = statusBuffer.split('\n'); statusBuffer = lines.pop() || ''; for (const line of lines)
    if (line.trim())
        updateLanding(line.trim()); }); statusClient.on('error', () => { }); statusClient.on('close', () => setTimeout(connectLandingStatus, 1500)); }
connectLandingStatus();
let ffmpeg;
function startVideo() {
    if (ffmpeg)
        return;
    ffmpeg = spawn(FFMPEG_PATH, ['-loglevel', 'warning', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', RTSP_URL, '-an', '-c:v', 'copy', '-f', 'mpegts', 'pipe:1']);
    ffmpeg.stdout.on('data', chunk => { for (const ws of videoWs.clients)
        if (ws.readyState === WebSocket.OPEN)
            ws.send(chunk, { binary: true }); });
    ffmpeg.stderr.on('data', d => console.error(`[video] ${d.toString().trim()}`));
    ffmpeg.on('error', error => console.error(`[video] cannot start FFmpeg: ${error.message}`));
    ffmpeg.on('close', () => { ffmpeg = undefined; if (videoWs.clients.size > 0)
        setTimeout(() => { if (videoWs.clients.size > 0)
            startVideo(); }, 1500); });
}
videoWs.on('connection', ws => { startVideo(); ws.on('close', () => setImmediate(() => { if (videoWs.clients.size === 0 && ffmpeg)
    ffmpeg.kill('SIGTERM'); })); });
server.listen(PORT, '0.0.0.0', () => console.log(`Dashboard backend http://localhost:${PORT} | MAVLink ${RV_HOST}:${MAVLINK_PORT} | ${RTSP_URL} | FFmpeg ${FFMPEG_PATH}`));
