import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { MavlinkParser, decode, gcsHeartbeat, requestAllStreams, requestMessageInterval, requestParameter } from './mavlink.js';
import { ExperimentLogger } from './experiment-logger.js';
import { clearRemoteLogs, remoteLogSession, startRemoteLog, stopAndCollectRemoteLog } from './log-collector.js';
import { CameraCalibration } from './camera-calibration.js';
const RV_HOST = process.env.RV_HOST || '192.168.1.55';
const MAVLINK_PORT = Number(process.env.MAVLINK_PORT || 5760);
const RTSP_URL = process.env.RTSP_URL || `rtsp://${RV_HOST}:8554/live`;
const PORT = Number(process.env.PORT || 3001);
const SLAM_FFMPEG = '/home/haryono/.local/share/mamba/envs/SLAM/bin/ffmpeg';
const FFMPEG_PATH = process.env.FFMPEG_PATH || (existsSync(SLAM_FFMPEG) ? SLAM_FFMPEG : 'ffmpeg');
const logger = new ExperimentLogger(process.env.EXPERIMENT_LOG_DIR || resolve(process.cwd(), 'logs', 'precision-landing'));
let ffmpeg;
let currentRtspUrl = RTSP_URL;
const calibration = new CameraCalibration(RV_HOST, active => { currentRtspUrl = active ? `rtsp://${RV_HOST}:8554/cal` : RTSP_URL; if (ffmpeg)
    ffmpeg.kill('SIGTERM'); });
const state = { connected: false, lastUpdate: 0, battery: null, voltage: null, current: null, lat: null, lon: null, altitude: null, relativeAltitude: null, groundSpeed: null, heading: null, climb: null, gpsFix: null, satellites: null, armed: false, customMode: null, preclandHealthy: false, precland: { status: 'UNKNOWN', message: 'Waiting for ArduPilot PrecLand status', lastUpdate: 0 }, preclandEvents: [], landing: null, logging: logger.status() };
remoteLogSession(RV_HOST).then(sessionId => { if (sessionId)
    state.logging = logger.resume(sessionId); }).catch(error => console.error(`[logging] cannot synchronize remote state: ${error instanceof Error ? error.message : String(error)}`));
const app = express();
const server = createServer(app);
app.get('/api/config', (_req, res) => res.json({ rvHost: RV_HOST, mavlinkPort: MAVLINK_PORT, rtspUrl: RTSP_URL, statusPort: 14551 }));
app.get('/api/status', (_req, res) => res.json(state));
app.get('/api/mavlink-diagnostics', (_req, res) => res.json({ targetSystem, targetComponent, lastStreamRequest, messageLastSeen: Object.fromEntries(messageLastSeen), messageCounts: Object.fromEntries(messageCounts) }));
app.get('/api/logs/status', (_req, res) => res.json(logger.status()));
app.post('/api/logs/start', express.json(), async (req, res) => { try {
    if (calibration.status().active) {
        res.status(409).json({ error: 'stop camera calibration before flight logging' });
        return;
    }
    state.logging = logger.start(typeof req.body?.name === 'string' ? req.body.name : undefined);
    await startRemoteLog(state.logging.sessionId, RV_HOST);
    requestDiagnosticParameters();
    res.json(state.logging);
}
catch (error) {
    state.logging = logger.stop();
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
} });
app.post('/api/logs/stop', async (_req, res) => { const session = logger.status(); if (!session.sessionId) {
    res.json(session);
    return;
} try {
    const collection = await stopAndCollectRemoteLog(session.sessionId, logger.root, RV_HOST);
    state.logging = logger.stop();
    res.json({ ...state.logging, directory: collection.directory, collection });
}
catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error), ...session });
} });
app.delete('/api/logs', async (_req, res) => { try {
    await clearRemoteLogs(RV_HOST);
    const removed = logger.clear();
    state.logging = logger.status();
    res.json({ removed, ...state.logging });
}
catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
} });
app.get('/api/calibration/status', (_req, res) => res.json(calibration.status()));
app.post('/api/calibration/start', async (_req, res) => { try {
    if (logger.status().active) {
        res.status(409).json({ error: 'stop flight logging before calibration' });
        return;
    }
    res.json(await calibration.start());
}
catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
} });
app.post('/api/calibration/stop', async (_req, res) => { try {
    res.json(await calibration.stop());
}
catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...calibration.status() });
} });
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
function broadcastState() { state.logging = logger.status(); logger.state(state); const payload = JSON.stringify(state); for (const ws of telemetryWs.clients)
    if (ws.readyState === WebSocket.OPEN)
        ws.send(payload); }
setInterval(broadcastState, 300);
const parser = new MavlinkParser();
const messageLastSeen = new Map();
const messageCounts = new Map();
let targetSystem = 1, targetComponent = 1;
parser.on('frame', frame => {
    const msg = decode(frame);
    logger.frame({ id: frame.id, systemId: frame.systemId, componentId: frame.componentId, payloadBase64: frame.payload.toString('base64'), decoded: msg || null });
    if (!msg)
        return;
    state.connected = true;
    state.lastUpdate = Date.now();
    messageLastSeen.set(frame.id, state.lastUpdate);
    messageCounts.set(frame.id, (messageCounts.get(frame.id) || 0) + 1);
    if (msg.kind === 'heartbeat') {
        state.armed = (msg.baseMode & 128) !== 0;
        state.customMode = msg.customMode;
        if (frame.systemId !== targetSystem || frame.componentId !== targetComponent) {
            targetSystem = frame.systemId;
            targetComponent = frame.componentId;
            lastStreamRequest = 0;
        }
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
    else if (msg.kind === 'statusText') {
        const time = Date.now();
        let status = 'UNKNOWN';
        if (/PrecLand:/i.test(msg.text)) {
            if (/Target Found/i.test(msg.text))
                status = 'INITIALIZING';
            else if (/Init Complete/i.test(msg.text))
                status = 'TARGET_ACQUIRED';
            else if (/Target Lost/i.test(msg.text))
                status = 'TARGET_LOST';
            else if (/Init Failed/i.test(msg.text))
                status = 'INIT_FAILED';
            if (status !== 'UNKNOWN')
                state.precland = { status, message: msg.text, lastUpdate: time };
        }
        state.preclandEvents = [...state.preclandEvents.slice(-99), { time, text: msg.text, status }];
        console.log(`[ArduPilot] ${msg.text}`);
    }
});
let mavlink;
let lastStreamRequest = 0;
let socketConnectedAt = 0;
let reconnectTimer;
const requiredMessages = [1, 24, 30, 32, 33, 74, 193];
const diagnosticParameters = ['PLND_ENABLED', 'PLND_TYPE', 'PLND_EST_TYPE', 'PLND_ORIENT', 'PLND_YAW_ALIGN', 'PLND_LAG', 'PLND_XY_DIST_MAX', 'PLND_ALT_MAX', 'PLND_ALT_MIN', 'LAND_SPEED', 'LAND_SPEED_HIGH', 'WPNAV_SPEED_DN', 'RNGFND1_TYPE', 'EK3_SRC1_POSXY', 'EK3_SRC1_POSZ'];
function sendMavlink(buffer) { if (!mavlink?.writable)
    return false; logger.tx(buffer); return Boolean(mavlink.write(buffer)); }
function requestStreams() {
    if (!mavlink?.writable)
        return;
    sendMavlink(requestAllStreams(4, targetSystem, targetComponent));
    for (const id of requiredMessages)
        sendMavlink(requestMessageInterval(id, 4, targetSystem, targetComponent));
    lastStreamRequest = Date.now();
}
function requestDiagnosticParameters() { if (!mavlink?.writable)
    return; for (const name of diagnosticParameters)
    sendMavlink(requestParameter(name, targetSystem, targetComponent)); }
function scheduleReconnect() {
    if (reconnectTimer)
        return;
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connectMavlink(); }, 1500);
}
function connectMavlink() {
    mavlink?.destroy();
    const socket = net.createConnection({ host: RV_HOST, port: MAVLINK_PORT });
    mavlink = socket;
    socket.setKeepAlive(true, 3000);
    socket.setTimeout(10_000);
    socket.on('connect', () => { logger.event('mavlink_connected', { host: RV_HOST, port: MAVLINK_PORT }); socketConnectedAt = Date.now(); lastStreamRequest = 0; parser.reset(); sendMavlink(gcsHeartbeat()); requestStreams(); });
    socket.on('data', d => { logger.rx(d); parser.push(d); });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', error => logger.event('mavlink_error', { message: error.message }));
    socket.on('close', () => { logger.event('mavlink_disconnected'); if (mavlink === socket) {
        mavlink = undefined;
        state.connected = false;
        scheduleReconnect();
    } });
}
connectMavlink();
setInterval(() => {
    const now = Date.now();
    sendMavlink(gcsHeartbeat());
    const telemetryMissing = requiredMessages.some(id => now - (messageLastSeen.get(id) || 0) > 5000);
    if ((telemetryMissing && now - lastStreamRequest > 5000) || now - lastStreamRequest > 15_000)
        requestStreams();
    if (now - state.lastUpdate > 3000)
        state.connected = false;
    // A TCP socket may survive a board/FC restart without carrying MAVLink again.
    if (mavlink && !state.connected && now - socketConnectedAt > 10_000)
        mavlink.destroy();
}, 1000);
function updateLanding(raw) { const m = /TAG=(\w+).*?\binfer=([\d.]+)Hz.*?\bX=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)\s+MAV=(\w+)/.exec(raw); state.landing = { raw, tag: m?.[1] || 'UNKNOWN', inference: m ? Number(m[2]) : null, x: m ? Number(m[3]) : null, y: m ? Number(m[4]) : null, z: m ? Number(m[5]) : null, mavValid: m?.[6] === 'VALID', lastUpdate: Date.now() }; }
let statusClient, statusBuffer = '';
let latestLandingRaw;
setInterval(() => { if (latestLandingRaw !== undefined) {
    updateLanding(latestLandingRaw);
    latestLandingRaw = undefined;
} }, 300);
function connectLandingStatus() { statusClient?.destroy(); const socket = net.createConnection({ host: RV_HOST, port: 14551 }); statusClient = socket; socket.setKeepAlive(true, 3000); socket.setTimeout(10_000); socket.on('connect', () => logger.event('landing_status_connected', { host: RV_HOST, port: 14551 })); socket.on('data', data => { statusBuffer += data.toString(); const lines = statusBuffer.split('\n'); statusBuffer = lines.pop() || ''; for (const raw of lines) {
    const line = raw.trim();
    if (!line)
        continue;
    logger.landingLine(line);
    if (line.startsWith('TAG=') || line.startsWith('PL_STATUS '))
        latestLandingRaw = line.replace(/^PL_STATUS\s+/, '');
} }); socket.on('timeout', () => socket.destroy()); socket.on('error', error => logger.event('landing_status_error', { message: error.message })); socket.on('close', () => { logger.event('landing_status_disconnected'); if (statusClient === socket) {
    statusClient = undefined;
    statusBuffer = '';
    latestLandingRaw = undefined;
    setTimeout(connectLandingStatus, 1500);
} }); }
connectLandingStatus();
function startVideo() {
    if (ffmpeg)
        return;
    ffmpeg = spawn(FFMPEG_PATH, ['-loglevel', 'warning', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', currentRtspUrl, '-an', '-c:v', 'copy', '-f', 'mpegts', 'pipe:1']);
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
function shutdown() { state.logging = logger.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
