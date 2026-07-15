import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Pose = {
  x: number;
  y: number;
  yaw: number;
  score: number;
  valid: boolean;
  mode: 'global' | 'tracking';
};
type RobotStatus = {
  robot_id: string;
  online: boolean;
  pose: Pose;
  power: { percent: number; voltage: number };
};
type MapData = {
  map_id: string;
  resolution: number;
  origin: { x: number; y: number; yaw: number };
  width: number;
  height: number;
  pixels: string;
};
type ServerMessage =
  | { type: 'snapshot'; data: RobotStatus[] }
  | { type: 'robot_status'; data: RobotStatus }
  | { type: 'command_ack'; data: { command: string } }
  | { type: string; data?: unknown };

type MapViewProps = {
  map?: MapData;
  robot?: RobotStatus;
};

function MapView({ map, robot }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!map || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
    const mapOffsetX = (canvas.width - map.width * scale) / 2;
    const mapOffsetY = (canvas.height - map.height * scale) / 2;
    const grayscalePixels = Uint8Array.from(atob(map.pixels), (character) =>
      character.charCodeAt(0),
    );
    const mapImage = new ImageData(map.width, map.height);

    for (let index = 0; index < grayscalePixels.length; index++) {
      const gray = grayscalePixels[index]!;
      mapImage.data.set([gray, gray, gray, 255], index * 4);
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = map.width;
    offscreen.height = map.height;
    offscreen.getContext('2d')?.putImageData(mapImage, 0, 0);

    context.fillStyle = '#111827';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(offscreen, mapOffsetX, mapOffsetY, map.width * scale, map.height * scale);

    if (!robot?.pose) return;

    // Convert the localization pose (meters) into image coordinates (pixels).
    const mapCos = Math.cos(map.origin.yaw);
    const mapSin = Math.sin(map.origin.yaw);
    const worldDeltaX = robot.pose.x - map.origin.x;
    const worldDeltaY = robot.pose.y - map.origin.y;
    const mapX = (mapCos * worldDeltaX + mapSin * worldDeltaY) / map.resolution;
    const mapY = (-mapSin * worldDeltaX + mapCos * worldDeltaY) / map.resolution;
    const robotCanvasX = mapOffsetX + mapX * scale;
    const robotCanvasY = mapOffsetY + (map.height - mapY) * scale;

    context.save();
    context.translate(robotCanvasX, robotCanvasY);
    context.rotate(-(robot.pose.yaw - map.origin.yaw));
    context.fillStyle = robot.pose.valid ? '#22c55e' : '#ef4444';
    context.beginPath();
    context.moveTo(14, 0);
    context.lineTo(-10, -9);
    context.lineTo(-6, 0);
    context.lineTo(-10, 9);
    context.closePath();
    context.fill();
    context.restore();
  }, [map, robot]);

  return <canvas ref={canvasRef} width="900" height="650" />;
}

function App() {
  const [map, setMap] = useState<MapData>();
  const [robots, setRobots] = useState<Record<string, RobotStatus>>({});
  const [notice, setNotice] = useState('');
  useEffect(() => {
    fetch('/api/map')
      .then((r) => r.json() as Promise<MapData>)
      .then(setMap)
      .catch((e) => setNotice(String(e)));
  }, []);
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      if (msg.type === 'snapshot') {
        const list = msg.data as RobotStatus[];
        setRobots(Object.fromEntries(list.map((r) => [r.robot_id, r])));
      }
      if (msg.type === 'robot_status') {
        const robot = msg.data as RobotStatus;
        setRobots((old) => ({ ...old, [robot.robot_id]: robot }));
      }
      if (msg.type === 'command_ack')
        setNotice(`${(msg.data as { command: string }).command} diterima robot`);
    };
    return () => socket.close();
  }, []);
  const robot = Object.values(robots)[0];
  const mission = async (action: 'start' | 'stop') => {
    if (!robot) return;
    setNotice(`Mengirim ${action}...`);
    const response = await fetch(`/api/robots/${robot.robot_id}/mission/${action}`, {
      method: 'POST',
    });
    if (!response.ok) setNotice(((await response.json()) as { error: string }).error);
  };
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">LUCKFOX · AGV CONTROL</p>
          <h1>Ruang Utama</h1>
        </div>
        <span className={`connection ${robot?.online ? 'online' : ''}`}>
          {robot?.online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </header>
      <section className="layout">
        <div className="map">
          <MapView map={map} robot={robot} />
        </div>
        <aside>
          <div className="card">
            <span>Robot</span>
            <strong>{robot?.robot_id || 'Menunggu...'}</strong>
          </div>
          <div className="metrics">
            <div>
              <span>X</span>
              <b>{robot?.pose?.x?.toFixed(2) ?? '—'} m</b>
            </div>
            <div>
              <span>Y</span>
              <b>{robot?.pose?.y?.toFixed(2) ?? '—'} m</b>
            </div>
            <div>
              <span>Yaw</span>
              <b>{robot?.pose ? ((robot.pose.yaw * 180) / Math.PI).toFixed(1) : '—'}°</b>
            </div>
            <div>
              <span>Score</span>
              <b>{robot?.pose?.score?.toFixed(3) ?? '—'}</b>
            </div>
          </div>
          <div className="card">
            <span>Localization</span>
            <strong>{robot?.pose?.mode?.toUpperCase() || 'UNKNOWN'}</strong>
            <small>{robot?.pose?.valid ? 'Pose valid' : 'Pose belum valid'}</small>
          </div>
          <div className="card">
            <span>Power</span>
            <strong>
              {robot?.power?.percent >= 0 ? `${robot.power.percent.toFixed(0)}%` : 'N/A'}
            </strong>
            <small>
              {robot?.power?.voltage > 0
                ? `${robot.power.voltage.toFixed(1)} V`
                : 'Sensor belum terhubung'}
            </small>
          </div>
          <button disabled={!robot?.online} onClick={() => mission('start')}>
            START MISSION
          </button>
          <button className="stop" disabled={!robot?.online} onClick={() => mission('stop')}>
            STOP MISSION
          </button>
          <p className="notice">{notice}</p>
        </aside>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
