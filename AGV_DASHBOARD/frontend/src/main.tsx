import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
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
  mission_running: boolean;
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
  | { type: 'mapping_status'; data: { state: MappingState } }
  | { type: 'mapping_map'; data: MapData }
  | { type: 'map_saved'; data: { name: string } }
  | { type: 'map_transfer_started'; data: { name: string } }
  | { type: 'map_transfer_ack'; data: { success: boolean; transfer_id: number } }
  | { type: string; data?: unknown };

type MappingState = 'stopped' | 'starting' | 'running' | 'stopping' | 'saving' | 'error';

type MapViewProps = {
  map?: MapData;
  robot?: RobotStatus;
};

type MapPoint = { x: number; y: number };
type WallMeasurement = { start: MapPoint; end: MapPoint };

function mapTransform(canvas: HTMLCanvasElement, map: MapData) {
  const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
  return {
    scale,
    offsetX: (canvas.width - map.width * scale) / 2,
    offsetY: (canvas.height - map.height * scale) / 2,
  };
}

function snapToBlackPixel(
  point: MapPoint,
  pixels: Uint8Array,
  map: MapData,
  radius: number,
): MapPoint {
  let nearest = point;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);

  for (
    let y = Math.max(0, centerY - radius);
    y <= Math.min(map.height - 1, centerY + radius);
    y++
  ) {
    for (
      let x = Math.max(0, centerX - radius);
      x <= Math.min(map.width - 1, centerX + radius);
      x++
    ) {
      if (pixels[y * map.width + x]! > 60) continue;
      const distanceSquared = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (distanceSquared < nearestDistanceSquared) {
        nearest = { x, y };
        nearestDistanceSquared = distanceSquared;
      }
    }
  }
  return nearest;
}

function MapView({ map, robot }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [measuring, setMeasuring] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<MapPoint>();
  const [measurements, setMeasurements] = useState<WallMeasurement[]>([]);
  const grayscalePixels = useMemo(
    () =>
      map ? Uint8Array.from(atob(map.pixels), (character) => character.charCodeAt(0)) : undefined,
    [map],
  );

  useEffect(() => {
    setPendingPoint(undefined);
    setMeasurements([]);
  }, [map?.map_id]);

  useEffect(() => {
    if (!map || !grayscalePixels || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { scale, offsetX: mapOffsetX, offsetY: mapOffsetY } = mapTransform(canvas, map);
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

    const toCanvas = (point: MapPoint): MapPoint => ({
      x: mapOffsetX + point.x * scale,
      y: mapOffsetY + point.y * scale,
    });

    for (const measurement of measurements) {
      const start = toCanvas(measurement.start);
      const end = toCanvas(measurement.end);
      const lengthMeters =
        Math.hypot(
          measurement.end.x - measurement.start.x,
          measurement.end.y - measurement.start.y,
        ) * map.resolution;

      context.save();
      context.strokeStyle = '#0ea5e9';
      context.fillStyle = '#0ea5e9';
      context.lineWidth = 2;
      context.setLineDash([7, 5]);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      context.setLineDash([]);
      for (const point of [start, end]) {
        context.beginPath();
        context.arc(point.x, point.y, 4, 0, Math.PI * 2);
        context.fill();
      }

      const label = `${lengthMeters.toFixed(2)} m`;
      const labelX = (start.x + end.x) / 2;
      const labelY = (start.y + end.y) / 2;
      context.font = '700 15px ui-monospace, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const labelWidth = context.measureText(label).width + 14;
      context.fillStyle = '#07111fdd';
      context.fillRect(labelX - labelWidth / 2, labelY - 14, labelWidth, 28);
      context.fillStyle = '#e0f2fe';
      context.fillText(label, labelX, labelY);
      context.restore();
    }

    if (pendingPoint) {
      const pending = toCanvas(pendingPoint);
      context.fillStyle = '#facc15';
      context.beginPath();
      context.arc(pending.x, pending.y, 6, 0, Math.PI * 2);
      context.fill();
    }

    if (robot?.pose) {
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
    }
  }, [grayscalePixels, map, measurements, pendingPoint, robot]);

  const handleMapClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!measuring || !map || !grayscalePixels || !canvas) return;

    const bounds = canvas.getBoundingClientRect();
    const canvasX = (event.clientX - bounds.left) * (canvas.width / bounds.width);
    const canvasY = (event.clientY - bounds.top) * (canvas.height / bounds.height);
    const { scale, offsetX, offsetY } = mapTransform(canvas, map);
    const rawPoint = { x: (canvasX - offsetX) / scale, y: (canvasY - offsetY) / scale };
    if (rawPoint.x < 0 || rawPoint.x >= map.width || rawPoint.y < 0 || rawPoint.y >= map.height)
      return;

    const point = snapToBlackPixel(
      rawPoint,
      grayscalePixels,
      map,
      Math.max(3, Math.min(20, Math.round(14 / scale))),
    );
    if (!pendingPoint) setPendingPoint(point);
    else {
      setMeasurements((current) => [...current, { start: pendingPoint, end: point }]);
      setPendingPoint(undefined);
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width="900"
        height="650"
        className={measuring ? 'measuring' : ''}
        onClick={handleMapClick}
      />
      <div className="measurement-tools">
        <button
          type="button"
          className={measuring ? 'active' : ''}
          onClick={() => {
            setMeasuring((current) => !current);
            setPendingPoint(undefined);
          }}
        >
          {measuring ? 'SELESAI UKUR' : 'UKUR RUSUK'}
        </button>
        <button
          type="button"
          disabled={!pendingPoint && measurements.length === 0}
          onClick={() => {
            if (pendingPoint) setPendingPoint(undefined);
            else setMeasurements((current) => current.slice(0, -1));
          }}
        >
          UNDO
        </button>
        <button
          type="button"
          disabled={!pendingPoint && measurements.length === 0}
          onClick={() => {
            setPendingPoint(undefined);
            setMeasurements([]);
          }}
        >
          HAPUS
        </button>
      </div>
      {measuring && (
        <div className="measurement-hint">
          {pendingPoint ? 'Klik ujung kedua rusuk' : 'Klik dua ujung rusuk hitam'}
        </div>
      )}
    </>
  );
}

function App() {
  const [map, setMap] = useState<MapData>();
  const [robots, setRobots] = useState<Record<string, RobotStatus>>({});
  const [notice, setNotice] = useState('');
  const [mappingState, setMappingState] = useState<MappingState>('stopped');
  const [savedMap, setSavedMap] = useState<string>();
  useEffect(() => {
    fetch('/api/map')
      .then((r) => r.json() as Promise<MapData>)
      .then(setMap)
      .catch((e) => setNotice(String(e)));
  }, []);
  useEffect(() => {
    fetch('/api/mapping/status')
      .then(
        (response) => response.json() as Promise<{ state: MappingState; last_saved_map?: string }>,
      )
      .then((status) => {
        setMappingState(status.state);
        setSavedMap(status.last_saved_map);
      })
      .catch((error) => setNotice(String(error)));
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
      if (msg.type === 'mapping_status')
        setMappingState((msg.data as { state: MappingState }).state);
      if (msg.type === 'mapping_map') setMap(msg.data as MapData);
      if (msg.type === 'map_saved') setSavedMap((msg.data as { name: string }).name);
      if (msg.type === 'map_transfer_started')
        setNotice(`Mengirim map ${(msg.data as { name: string }).name}...`);
      if (msg.type === 'map_transfer_ack')
        setNotice(
          (msg.data as { success: boolean }).success
            ? 'Map berhasil dipasang di robot'
            : 'Robot menolak map: validasi gagal',
        );
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
  const mappingAction = async (action: 'start' | 'stop' | 'save') => {
    setNotice(`Mapping ${action}...`);
    const response = await fetch(`/api/mapping/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: action === 'save' ? JSON.stringify({ name: 'ruang_utama' }) : undefined,
    });
    const result = (await response.json()) as { error?: string; state?: MappingState };
    if (!response.ok) setNotice(result.error ?? 'Mapping command gagal');
    else setNotice(`Mapping ${result.state}`);
  };
  const transferMap = async () => {
    if (!robot || !savedMap) return;
    setNotice(`Menyiapkan transfer ${savedMap}...`);
    const response = await fetch(`/api/maps/${savedMap}/transfer/${robot.robot_id}`, {
      method: 'POST',
    });
    if (!response.ok) {
      const result = (await response.json()) as { error: string };
      setNotice(result.error);
    }
  };
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGV CONTROL</p>
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
          <div className="status-grid">
            <div className="card compact-card">
              <span>Mission</span>
              <strong>{robot?.mission_running ? 'RUNNING' : 'STOPPED'}</strong>
              <small>{robot?.mission_running ? 'LiDAR aktif' : 'LiDAR berhenti'}</small>
            </div>
            <div className="card compact-card">
              <span>Mapping</span>
              <strong>{mappingState.toUpperCase()}</strong>
              <small>RF2O + SLAM</small>
            </div>
            <div className="card compact-card">
              <span>Robot</span>
              <strong>{robot?.robot_id || 'Menunggu...'}</strong>
              <small>{robot?.online ? 'Terhubung' : 'Tidak terhubung'}</small>
            </div>
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
          <div className="controls">
            <button
              disabled={!robot?.online || robot?.mission_running}
              onClick={() => mission('start')}
            >
              START MISSION
            </button>
            <button
              className="stop"
              disabled={!robot?.online || !robot?.mission_running}
              onClick={() => mission('stop')}
            >
              STOP MISSION
            </button>
            <button
              disabled={!robot?.online || mappingState !== 'stopped'}
              onClick={() => mappingAction('start')}
            >
              START MAPPING
            </button>
            <button
              className="stop"
              disabled={mappingState === 'stopped' || mappingState === 'stopping'}
              onClick={() => mappingAction('stop')}
            >
              STOP MAPPING
            </button>
            <button disabled={mappingState !== 'running'} onClick={() => mappingAction('save')}>
              SAVE MAP
            </button>
            <button disabled={!robot?.online || !savedMap} onClick={transferMap}>
              TRANSFER MAP
            </button>
          </div>
          <p className="notice">{notice}</p>
        </aside>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
