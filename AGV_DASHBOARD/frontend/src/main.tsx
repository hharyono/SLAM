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

type ExperimentRunType =
  'ground_truth' | 'route' | 'kidnapped' | 'dynamic_occluded' | 'ablation' | 'resource';
type ExperimentState =
  | 'created'
  | 'starting'
  | 'capturing'
  | 'stopping'
  | 'stopped'
  | 'analyzed'
  | 'finalized'
  | 'error';
type ExperimentSession = {
  experiment_id: string;
  condition: 'nominal' | 'lidar_occluded_90' | 'furniture_changed' | 'dynamic_occluded';
  run_type: ExperimentRunType;
  trial: number;
  route_id: string;
  zone: string;
  state: ExperimentState;
  status_count: number;
  source_experiment_id?: string;
  error?: string;
};
type ExperimentPreflight = {
  board_target: string;
  backend_unix_ms: number;
  local_map_sha256: string;
  board_map_sha256?: string;
  local_binary_sha256?: string;
  board_binary_sha256?: string;
  map_match?: boolean;
  binary_match?: boolean;
  board_clock_offset_ms?: number;
  mapper_status: string;
  board_report: string;
  git_dirty: boolean;
};

type MapViewProps = {
  map?: MapData;
  robot?: RobotStatus;
};

type MapPoint = { x: number; y: number };
type MetricPoint = { x: number; y: number };
type WallMeasurement = { start: MapPoint; end: MapPoint };

type MapDisplayTransform = {
  scale: number;
  rotation: number;
  centerX: number;
  centerY: number;
  toCanvas: (point: MapPoint) => MapPoint;
  fromCanvas: (point: MapPoint) => MapPoint;
};

function mapTransform(canvas: HTMLCanvasElement, map: MapData): MapDisplayTransform {
  const rotation = -map.origin.yaw;
  const rotationCos = Math.cos(rotation);
  const rotationSin = Math.sin(rotation);
  const rotatedWidth = Math.abs(map.width * rotationCos) + Math.abs(map.height * rotationSin);
  const rotatedHeight = Math.abs(map.width * rotationSin) + Math.abs(map.height * rotationCos);
  const padding = 58;
  const scale = Math.min(
    (canvas.width - padding * 2) / rotatedWidth,
    (canvas.height - padding * 2) / rotatedHeight,
  );
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const toCanvas = (point: MapPoint): MapPoint => {
    const x = (point.x - map.width / 2) * scale;
    const y = (point.y - map.height / 2) * scale;
    return {
      x: centerX + rotationCos * x - rotationSin * y,
      y: centerY + rotationSin * x + rotationCos * y,
    };
  };
  const fromCanvas = (point: MapPoint): MapPoint => {
    const x = point.x - centerX;
    const y = point.y - centerY;
    return {
      x: (rotationCos * x + rotationSin * y) / scale + map.width / 2,
      y: (-rotationSin * x + rotationCos * y) / scale + map.height / 2,
    };
  };
  return {
    scale,
    rotation,
    centerX,
    centerY,
    toCanvas,
    fromCanvas,
  };
}

function imageToWorld(point: MapPoint, map: MapData): MetricPoint {
  const mapX = point.x * map.resolution;
  const mapY = (map.height - point.y) * map.resolution;
  const mapCos = Math.cos(map.origin.yaw);
  const mapSin = Math.sin(map.origin.yaw);
  return {
    x: map.origin.x + mapCos * mapX - mapSin * mapY,
    y: map.origin.y + mapSin * mapX + mapCos * mapY,
  };
}

function worldToImage(point: MetricPoint, map: MapData): MapPoint {
  const mapCos = Math.cos(map.origin.yaw);
  const mapSin = Math.sin(map.origin.yaw);
  const worldDeltaX = point.x - map.origin.x;
  const worldDeltaY = point.y - map.origin.y;
  const mapX = mapCos * worldDeltaX + mapSin * worldDeltaY;
  const mapY = -mapSin * worldDeltaX + mapCos * worldDeltaY;
  return {
    x: mapX / map.resolution,
    y: map.height - mapY / map.resolution,
  };
}

function mapWorldBounds(map: MapData): {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
} {
  const corners = [
    imageToWorld({ x: 0, y: 0 }, map),
    imageToWorld({ x: map.width, y: 0 }, map),
    imageToWorld({ x: map.width, y: map.height }, map),
    imageToWorld({ x: 0, y: map.height }, map),
  ];
  return {
    minimumX: Math.min(...corners.map((point) => point.x)),
    maximumX: Math.max(...corners.map((point) => point.x)),
    minimumY: Math.min(...corners.map((point) => point.y)),
    maximumY: Math.max(...corners.map((point) => point.y)),
  };
}

function drawMetricGrid(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  map: MapData,
  transform: MapDisplayTransform,
): void {
  const imageCorners = [
    transform.toCanvas({ x: 0, y: 0 }),
    transform.toCanvas({ x: map.width, y: 0 }),
    transform.toCanvas({ x: map.width, y: map.height }),
    transform.toCanvas({ x: 0, y: map.height }),
  ];
  const screenBounds = {
    minimumX: Math.min(...imageCorners.map((point) => point.x)),
    maximumX: Math.max(...imageCorners.map((point) => point.x)),
    minimumY: Math.min(...imageCorners.map((point) => point.y)),
    maximumY: Math.max(...imageCorners.map((point) => point.y)),
  };
  const bounds = mapWorldBounds(map);
  const worldToCanvas = (point: MetricPoint) => transform.toCanvas(worldToImage(point, map));
  // The YAML origin is serialized with finite decimal precision. Include an
  // integer boundary such as Y=0 even if round-off leaves it a few nanometres
  // outside the calculated bounds.
  const gridMinimum = (value: number) => Math.ceil(value - 1e-6);
  const gridMaximum = (value: number) => Math.floor(value + 1e-6);

  context.save();
  context.font = '700 10px ui-monospace, monospace';
  context.lineWidth = 1;
  for (let x = gridMinimum(bounds.minimumX); x <= gridMaximum(bounds.maximumX); x++) {
    const start = worldToCanvas({ x, y: bounds.minimumY });
    const end = worldToCanvas({ x, y: bounds.maximumY });
    context.strokeStyle = Math.abs(x) < 1e-6 ? '#38bdf8dd' : '#64748b66';
    context.lineWidth = Math.abs(x) < 1e-6 ? 2 : 1;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  for (let y = gridMinimum(bounds.minimumY); y <= gridMaximum(bounds.maximumY); y++) {
    const start = worldToCanvas({ x: bounds.minimumX, y });
    const end = worldToCanvas({ x: bounds.maximumX, y });
    context.strokeStyle = Math.abs(y) < 1e-6 ? '#38bdf8dd' : '#64748b66';
    context.lineWidth = Math.abs(y) < 1e-6 ? 2 : 1;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  context.restore();

  context.save();
  context.font = '800 12px ui-monospace, monospace';
  context.fillStyle = '#0f172a';
  context.strokeStyle = '#f8fafc';
  context.lineWidth = 3;
  context.lineJoin = 'round';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const xLabelY = Math.min(canvas.height - 16, screenBounds.maximumY + 10);
  for (let x = gridMinimum(bounds.minimumX); x <= gridMaximum(bounds.maximumX); x++) {
    const position = worldToCanvas({ x, y: 0 });
    if (position.x >= 12 && position.x <= canvas.width - 12) {
      context.strokeText(`${x} m`, position.x, xLabelY);
      context.fillText(`${x} m`, position.x, xLabelY);
    }
  }

  context.textAlign = 'right';
  context.textBaseline = 'middle';
  const yLabelX = Math.max(38, screenBounds.minimumX - 10);
  for (let y = gridMinimum(bounds.minimumY); y <= gridMaximum(bounds.maximumY); y++) {
    const position = worldToCanvas({ x: 0, y });
    if (position.y >= 12 && position.y <= canvas.height - 12) {
      context.strokeText(`${y} m`, yLabelX, position.y);
      context.fillText(`${y} m`, yLabelX, position.y);
    }
  }
  context.restore();
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
  const [cursorWorld, setCursorWorld] = useState<MetricPoint>();
  const grayscalePixels = useMemo(
    () =>
      map ? Uint8Array.from(atob(map.pixels), (character) => character.charCodeAt(0)) : undefined,
    [map],
  );

  useEffect(() => {
    setPendingPoint(undefined);
    setMeasurements([]);
    setCursorWorld(undefined);
  }, [map?.map_id]);

  useEffect(() => {
    if (!map || !grayscalePixels || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    const transform = mapTransform(canvas, map);
    const { scale } = transform;
    const mapImage = new ImageData(map.width, map.height);

    for (let index = 0; index < grayscalePixels.length; index++) {
      const gray = grayscalePixels[index]!;
      mapImage.data.set([gray, gray, gray, 255], index * 4);
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = map.width;
    offscreen.height = map.height;
    offscreen.getContext('2d')?.putImageData(mapImage, 0, 0);

    // Match Nav2's trinary unknown-space gray (PGM value 205) so the
    // rotated map does not appear inside a separate dark rectangle.
    context.fillStyle = '#cdcdcd';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.save();
    context.translate(transform.centerX, transform.centerY);
    context.rotate(transform.rotation);
    context.drawImage(
      offscreen,
      (-map.width * scale) / 2,
      (-map.height * scale) / 2,
      map.width * scale,
      map.height * scale,
    );
    context.restore();

    drawMetricGrid(context, canvas, map, transform);

    for (const measurement of measurements) {
      const start = transform.toCanvas(measurement.start);
      const end = transform.toCanvas(measurement.end);
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
      const startWorld = imageToWorld(measurement.start, map);
      const endWorld = imageToWorld(measurement.end, map);
      const coordinateLabel =
        `A(${startWorld.x.toFixed(2)}, ${startWorld.y.toFixed(2)})  ` +
        `B(${endWorld.x.toFixed(2)}, ${endWorld.y.toFixed(2)})`;
      const labelX = (start.x + end.x) / 2;
      const labelY = (start.y + end.y) / 2;
      context.font = '700 15px ui-monospace, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const labelWidth =
        Math.max(context.measureText(label).width, context.measureText(coordinateLabel).width) + 14;
      context.fillStyle = '#07111fdd';
      context.fillRect(labelX - labelWidth / 2, labelY - 24, labelWidth, 48);
      context.fillStyle = '#e0f2fe';
      context.fillText(label, labelX, labelY - 8);
      context.font = '700 10px ui-monospace, monospace';
      context.fillStyle = '#7dd3fc';
      context.fillText(coordinateLabel, labelX, labelY + 10);
      context.restore();
    }

    if (pendingPoint) {
      const pending = transform.toCanvas(pendingPoint);
      context.fillStyle = '#facc15';
      context.beginPath();
      context.arc(pending.x, pending.y, 6, 0, Math.PI * 2);
      context.fill();
    }

    if (robot?.pose) {
      const robotCanvas = transform.toCanvas(
        worldToImage({ x: robot.pose.x, y: robot.pose.y }, map),
      );
      const worldBounds = mapWorldBounds(map);
      const horizontalStart = transform.toCanvas(
        worldToImage({ x: worldBounds.minimumX, y: robot.pose.y }, map),
      );
      const horizontalEnd = transform.toCanvas(
        worldToImage({ x: worldBounds.maximumX, y: robot.pose.y }, map),
      );
      const verticalStart = transform.toCanvas(
        worldToImage({ x: robot.pose.x, y: worldBounds.minimumY }, map),
      );
      const verticalEnd = transform.toCanvas(
        worldToImage({ x: robot.pose.x, y: worldBounds.maximumY }, map),
      );

      context.save();
      context.strokeStyle = '#38bdf8';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(horizontalStart.x, horizontalStart.y);
      context.lineTo(horizontalEnd.x, horizontalEnd.y);
      context.moveTo(verticalStart.x, verticalStart.y);
      context.lineTo(verticalEnd.x, verticalEnd.y);
      context.stroke();
      context.restore();

      context.save();
      context.translate(robotCanvas.x, robotCanvas.y);
      context.rotate(-robot.pose.yaw);
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
    const transform = mapTransform(canvas, map);
    const rawPoint = transform.fromCanvas({ x: canvasX, y: canvasY });
    if (rawPoint.x < 0 || rawPoint.x >= map.width || rawPoint.y < 0 || rawPoint.y >= map.height)
      return;

    const point = snapToBlackPixel(
      rawPoint,
      grayscalePixels,
      map,
      Math.max(3, Math.min(20, Math.round(14 / transform.scale))),
    );
    if (!pendingPoint) setPendingPoint(point);
    else {
      setMeasurements((current) => [...current, { start: pendingPoint, end: point }]);
      setPendingPoint(undefined);
    }
  };

  const handleMapMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!map || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const canvasPoint = {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
    const imagePoint = mapTransform(canvas, map).fromCanvas(canvasPoint);
    if (
      imagePoint.x < 0 ||
      imagePoint.x > map.width ||
      imagePoint.y < 0 ||
      imagePoint.y > map.height
    ) {
      setCursorWorld(undefined);
      return;
    }
    setCursorWorld(imageToWorld(imagePoint, map));
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width="900"
        height="650"
        className={measuring ? 'measuring' : ''}
        onClick={handleMapClick}
        onMouseMove={handleMapMove}
        onMouseLeave={() => setCursorWorld(undefined)}
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
          {measuring ? 'FINISH MEASURING' : 'MEASURE WALL'}
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
          CLEAR
        </button>
      </div>
      <div className="coordinate-readout" aria-live="polite">
        <small>MAP COORDINATE</small>
        <span>X</span>
        <b>{cursorWorld ? `${cursorWorld.x.toFixed(2)} m` : '—'}</b>
        <span>Y</span>
        <b>{cursorWorld ? `${cursorWorld.y.toFixed(2)} m` : '—'}</b>
        <em>X → · Y ↑ · grid 1 m</em>
      </div>
      {measuring && (
        <div className="measurement-hint">
          {pendingPoint ? 'Click the second wall endpoint' : 'Click two endpoints on a black wall'}
        </div>
      )}
    </>
  );
}

type ExperimentPanelProps = {
  robot?: RobotStatus;
  mission: (action: 'start' | 'stop') => Promise<void>;
  setNotice: (message: string) => void;
};

const TestDescriptions: Record<ExperimentRunType, string> = {
  ground_truth: 'Repeat one surveyed marker placement 10 times to quantify reference uncertainty.',
  route:
    'Measure checkpoint localization on two routes under nominal, static-occlusion, and furniture-change conditions.',
  kidnapped: 'Measure global relocalization after same-room or cross-room relocation.',
  dynamic_occluded: 'Measure checkpoint robustness while one person crosses at trigger T0.',
  ablation: 'Replay an existing raw recording through four matcher configurations.',
  resource: 'Measure three 60-second states: idle, normal tracking, and global relocalization.',
};

const TestGuides: Record<ExperimentRunType, string[]> = {
  ground_truth: [
    'Use one surveyed marker and keep its reference coordinates unchanged.',
    'Place the robot at the marker, wait for a valid pose, and record the checkpoint.',
    'Remove and reposition the robot before every repetition.',
    'Complete exactly 10 independent placements.',
  ],
  route: [
    'Press ROUTE START at the starting marker.',
    'Drive the frozen route and stop at each surveyed marker.',
    'Select the marker reference and press RECORD CHECKPOINT.',
    'Press ROUTE END at the final marker.',
  ],
  kidnapped: [
    'Wait until localization is stable in TRACKING mode.',
    'Press KIDNAP START, cover or lift the LiDAR, then move the robot.',
    'Select the destination reference and press KIDNAP RELEASE.',
    'Wait for TRACKING recovery, then record the final checkpoint.',
  ],
  dynamic_occluded: [
    'Place floor markers H1, H2, and trigger marker T0 as defined in the test plan.',
    'Press ROUTE START, then drive the selected route at the standard speed.',
    'At T0, press PERSON START as the person begins crossing H1–H2 or H2–H1.',
    'Press PERSON END at the opposite endpoint; the required duration is 3 ± 0.5 seconds.',
    'Record all eight checkpoints, press ROUTE END, then complete analysis and finalization.',
  ],
  ablation: [
    'Select a finalized route or kidnapped recording with raw scans.',
    'Run replay; no new physical experiment or board capture is required.',
    'Analyze local-only, local+global, single-resolution, and multi-resolution output.',
    'Repeat with at least 10 representative recordings.',
  ],
  resource: [
    'Record IDLE for 60 seconds while capture is active and the mission is stopped.',
    'Start the mission, then record NORMAL TRACKING for 60 seconds.',
    'Force relocalization and record GLOBAL RELOCALIZATION for 60 seconds.',
    'Repeat each state five times; CPU, RAM, processing time, and update rate are recorded automatically.',
  ],
};

async function JsonRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function ExperimentPanel({ robot, mission, setNotice }: ExperimentPanelProps) {
  const [runType, setRunType] = useState<ExperimentRunType>('route');
  const [condition, setCondition] = useState<ExperimentSession['condition']>('nominal');
  const [routeId, setRouteId] = useState('R1_ROOM_1_TO_2');
  const [zone, setZone] = useState('cross_room');
  const [trial, setTrial] = useState(1);
  const [session, setSession] = useState<ExperimentSession>();
  const [sessions, setSessions] = useState<ExperimentSession[]>([]);
  const [preflight, setPreflight] = useState<ExperimentPreflight>();
  const [busy, setBusy] = useState(false);
  const [markerId, setMarkerId] = useState('M1');
  const [markerX, setMarkerX] = useState('0');
  const [markerY, setMarkerY] = useState('0');
  const [markerYaw, setMarkerYaw] = useState('0');
  const [markerZone, setMarkerZone] = useState('room_1');
  const [report, setReport] = useState<Record<string, unknown>>();
  const [sourceExperimentId, setSourceExperimentId] = useState('');
  const [checkpointCount, setCheckpointCount] = useState(0);
  const [resourceRepetition, setResourceRepetition] = useState(1);
  const [resourceMeasurementCount, setResourceMeasurementCount] = useState(0);
  const [dynamicCrossingStartedAt, setDynamicCrossingStartedAt] = useState<number>();
  const [dynamicCrossingDuration, setDynamicCrossingDuration] = useState<number>();

  const Refresh = async () => {
    const [active, list] = await Promise.all([
      JsonRequest<ExperimentSession | null>('/api/experiments/active'),
      JsonRequest<ExperimentSession[]>('/api/experiments'),
    ]);
    if (active) setSession(active);
    else if (session) {
      const updated = list.find((item) => item.experiment_id === session.experiment_id);
      if (updated) setSession(updated);
    }
    setSessions(list);
  };

  useEffect(() => {
    Refresh().catch((error) => setNotice(String(error)));
    const timer = window.setInterval(() => Refresh().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (runType === 'ground_truth') setRouteId('GROUND_TRUTH_REPEAT');
    if (runType === 'route') setRouteId('R1_ROOM_1_TO_2');
    if (runType === 'kidnapped') setRouteId('KIDNAP_SAME_ROOM');
    if (runType === 'dynamic_occluded') setRouteId('R1_ROOM_1_TO_2');
    if (runType === 'ablation') setRouteId('ABLATION_REPLAY');
    if (runType === 'resource') setRouteId('RESOURCE_SEQUENCE');
    if (runType === 'dynamic_occluded') setCondition('dynamic_occluded');
    else if (runType !== 'route') setCondition('nominal');
  }, [runType]);

  useEffect(() => {
    if (sourceExperimentId) return;
    const candidate = sessions.find(
      (item) =>
        item.state === 'finalized' &&
        ['route', 'kidnapped', 'dynamic_occluded'].includes(item.run_type),
    );
    if (candidate) setSourceExperimentId(candidate.experiment_id);
  }, [sessions, sourceExperimentId]);

  const Run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await Refresh();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const CreateSession = () =>
    Run(async () => {
      const created = await JsonRequest<ExperimentSession>('/api/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          condition,
          run_type: runType,
          trial,
          route_id: routeId,
          zone,
          ground_truth_method: 'surveyed_floor_markers',
          robot_id: robot?.robot_id || 'AGV-001',
          source_experiment_id: runType === 'ablation' ? sourceExperimentId : undefined,
        }),
      });
      setSession(created);
      setReport(undefined);
      setCheckpointCount(0);
      setResourceMeasurementCount(0);
      setDynamicCrossingStartedAt(undefined);
      setDynamicCrossingDuration(undefined);
      setNotice(`Session created: ${created.experiment_id}`);
    });

  const SessionAction = (action: 'start' | 'stop' | 'analyze' | 'finalize') =>
    Run(async () => {
      if (!session) throw new Error('Create a session first');
      const result = await JsonRequest<ExperimentSession | { session: ExperimentSession }>(
        `/api/experiments/${session.experiment_id}/${action}`,
        { method: 'POST' },
      );
      const updated = 'session' in result ? result.session : result;
      setSession(updated);
      setNotice(`${action.toUpperCase()} completed: ${updated.state}`);
      if (action === 'analyze') {
        const data = await JsonRequest<Record<string, unknown>>(
          `/api/experiments/${session.experiment_id}/report`,
        );
        setReport(data);
      }
    });

  const RecordEvent = (
    event: string,
    includeReference = false,
    data: Record<string, unknown> = {},
  ) =>
    Run(async () => {
      if (!session) throw new Error('Start a capture session first');
      await JsonRequest(`/api/experiments/${session.experiment_id}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          marker_id: markerId,
          x: includeReference ? Number(markerX) : undefined,
          y: includeReference ? Number(markerY) : undefined,
          yaw: includeReference ? Number(markerYaw) : undefined,
          ...data,
        }),
      });
      if (event === 'DYNAMIC_OCCLUSION_START') {
        setDynamicCrossingStartedAt(Date.now());
        setDynamicCrossingDuration(undefined);
      }
      if (event === 'DYNAMIC_OCCLUSION_END' && dynamicCrossingStartedAt) {
        setDynamicCrossingDuration(Date.now() - dynamicCrossingStartedAt);
        setDynamicCrossingStartedAt(undefined);
      }
      if (event.startsWith('RESOURCE_') && event.endsWith('_END'))
        setResourceMeasurementCount((count) => count + 1);
      setNotice(`Event ${event} recorded`);
    });

  const RecordCheckpoint = () =>
    Run(async () => {
      if (!session) throw new Error('Start a capture session first');
      await JsonRequest(`/api/experiments/${session.experiment_id}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marker_id: markerId,
          zone: markerZone,
          x: Number(markerX),
          y: Number(markerY),
          yaw: Number(markerYaw),
        }),
      });
      setCheckpointCount((count) => count + 1);
      setNotice(`Checkpoint ${markerId} recorded`);
    });

  const RunAblation = () =>
    Run(async () => {
      if (!session) throw new Error('Create an ablation session first');
      const updated = await JsonRequest<ExperimentSession>(
        `/api/experiments/${session.experiment_id}/ablation`,
        { method: 'POST' },
      );
      setSession(updated);
      setNotice('Four ablation replay variants completed');
    });

  const RunPreflight = () =>
    Run(async () => {
      const result = await JsonRequest<ExperimentPreflight>('/api/experiments/preflight');
      setPreflight(result);
      setNotice('Preflight completed');
    });

  const finalized = sessions.filter((item) => item.state === 'finalized');
  const Progress = (targetCondition: ExperimentSession['condition']) =>
    finalized.filter((item) => item.condition === targetCondition && item.run_type === 'route')
      .length;
  const RunProgress = (targetType: ExperimentRunType, targetRoute?: string) =>
    finalized.filter(
      (item) => item.run_type === targetType && (!targetRoute || item.route_id === targetRoute),
    ).length;
  const capturing = session?.state === 'capturing';
  const canCreate = !session || ['finalized', 'error'].includes(session.state);
  const preflightReady = Boolean(
    preflight &&
    robot?.online &&
    !robot.mission_running &&
    preflight.map_match &&
    preflight.binary_match,
  );
  const flowLabels =
    runType === 'ablation'
      ? ['Preflight', 'Session', 'Replay', 'Analyze', 'Finalize']
      : ['Preflight', 'Session', 'Capture', 'Mission', 'Test', 'Stop', 'Analyze', 'Finalize'];
  const activeGuide = TestGuides[runType];
  const pedestrianDirection = routeId === 'R2_ROOM_2_TO_1' ? 'H2_TO_H1' : 'H1_TO_H2';

  return (
    <section className="experiment-panel">
      <div className="experiment-heading">
        <div>
          <span className="step-kicker">PUBLICATION TESTING</span>
          <h2>Guided Workflow</h2>
        </div>
        <span className={`session-state state-${session?.state || 'none'}`}>
          {session?.state?.toUpperCase() || 'NO SESSION'}
        </span>
      </div>

      <div className="test-selector">
        {(
          [
            'ground_truth',
            'route',
            'kidnapped',
            'dynamic_occluded',
            'ablation',
            'resource',
          ] as ExperimentRunType[]
        ).map((type) => (
          <button
            key={type}
            className={runType === type ? 'active' : ''}
            disabled={Boolean(session && !canCreate)}
            onClick={() => setRunType(type)}
          >
            <small>TEST TYPE</small>
            {type.replace('_', ' ').toUpperCase()}
          </button>
        ))}
      </div>
      <p className="test-description">{TestDescriptions[runType]}</p>

      <div className="workflow-overview" aria-label="Experiment procedure">
        {flowLabels.map((label, index) => (
          <div key={label}>
            <b>{index}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="workflow-card preflight-step">
        <div className="workflow-title">
          <b>0</b>
          <span>Verify the system before every trial</span>
        </div>
        <p className="step-help">
          Confirm that the robot is online, the mission is stopped, and the frozen map and binary
          match the board.
        </p>
        <button className="step-primary" disabled={busy} onClick={RunPreflight}>
          RUN PREFLIGHT
        </button>
        {preflight && (
          <>
            <div className="preflight-checks">
              <div className={robot?.online ? 'check-pass' : 'check-fail'}>
                <small>ROBOT</small>
                <b>{robot?.online ? 'ONLINE' : 'OFFLINE'}</b>
              </div>
              <div className={!robot?.mission_running ? 'check-pass' : 'check-fail'}>
                <small>MISSION</small>
                <b>{robot?.mission_running ? 'RUNNING' : 'STOPPED'}</b>
              </div>
              <div className={preflight.map_match ? 'check-pass' : 'check-fail'}>
                <small>MAP</small>
                <b>{preflight.map_match ? 'MATCH' : 'MISMATCH'}</b>
              </div>
              <div className={preflight.binary_match ? 'check-pass' : 'check-fail'}>
                <small>BINARY</small>
                <b>{preflight.binary_match ? 'MATCH' : 'MISMATCH'}</b>
              </div>
              <div className={!preflight.git_dirty ? 'check-pass' : 'check-warn'}>
                <small>GIT</small>
                <b>{preflight.git_dirty ? 'DIRTY' : 'CLEAN'}</b>
              </div>
              <div className="check-neutral">
                <small>CLOCK OFFSET</small>
                <b>
                  {preflight.board_clock_offset_ms === undefined
                    ? 'N/A'
                    : `${preflight.board_clock_offset_ms} ms`}
                </b>
              </div>
            </div>
            <details className="preflight-details">
              <summary>Technical details</summary>
              <div>
                <b>Board:</b> {preflight.board_target}
              </div>
              <div>
                <b>Map SHA:</b> {preflight.local_map_sha256.slice(0, 16)}…
              </div>
              <pre>{preflight.mapper_status}</pre>
              <pre>{preflight.board_report}</pre>
            </details>
          </>
        )}
      </div>

      <div className="workflow-card">
        <div className="workflow-title">
          <b>1</b>
          <span>Configure and create the trial session</span>
        </div>
        <p className="step-help">
          The robot ID, surveyed-marker ground truth, map, and output directory are assigned
          automatically.
        </p>
        <div className="form-grid">
          <label>
            Condition
            <select
              value={condition}
              disabled={runType !== 'route'}
              onChange={(event) =>
                setCondition(event.target.value as ExperimentSession['condition'])
              }
            >
              {runType === 'dynamic_occluded' ? (
                <option value="dynamic_occluded">Dynamic occlusion — person crossing</option>
              ) : (
                <>
                  <option value="nominal">Nominal</option>
                  <option value="lidar_occluded_90">LiDAR occluded 90°</option>
                  <option value="furniture_changed">Furniture arrangement changed</option>
                </>
              )}
            </select>
          </label>
          {(runType === 'route' || runType === 'dynamic_occluded') && (
            <label>
              Route
              <select value={routeId} onChange={(event) => setRouteId(event.target.value)}>
                <option value="R1_ROOM_1_TO_2">R1 — Room 1 to Room 2</option>
                <option value="R2_ROOM_2_TO_1">R2 — Room 2 to Room 1</option>
              </select>
            </label>
          )}
          {runType === 'kidnapped' && (
            <label>
              Relocation
              <select value={routeId} onChange={(event) => setRouteId(event.target.value)}>
                <option value="KIDNAP_SAME_ROOM">Within the same room</option>
                <option value="KIDNAP_CROSS_ROOM">Between rooms</option>
              </select>
            </label>
          )}
          {(runType === 'ground_truth' || runType === 'kidnapped') && (
            <label>
              Zone
              <select value={zone} onChange={(event) => setZone(event.target.value)}>
                <option value="room_1">Room 1</option>
                <option value="doorway_transition">Doorway</option>
                <option value="room_2">Room 2</option>
                <option value="cross_room">Cross room</option>
              </select>
            </label>
          )}
          {runType === 'ablation' && (
            <label className="wide-field">
              Source recording
              <select
                value={sourceExperimentId}
                onChange={(event) => setSourceExperimentId(event.target.value)}
              >
                <option value="">Select a finalized recording</option>
                {sessions
                  .filter(
                    (item) =>
                      item.state === 'finalized' &&
                      ['route', 'kidnapped', 'dynamic_occluded'].includes(item.run_type),
                  )
                  .map((item) => (
                    <option key={item.experiment_id} value={item.experiment_id}>
                      {item.experiment_id}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Trial
            <input
              type="number"
              min="0"
              max="999"
              value={trial}
              onChange={(event) => setTrial(Number(event.target.value))}
            />
          </label>
        </div>
        <button
          className="step-primary"
          disabled={
            busy || !canCreate || !preflightReady || (runType === 'ablation' && !sourceExperimentId)
          }
          onClick={CreateSession}
        >
          CREATE SESSION
        </button>
        {!preflightReady && (
          <p className="gate-message">
            Complete preflight with Robot ONLINE, Mission STOPPED, Map MATCH, and Binary MATCH.
          </p>
        )}
      </div>

      {runType === 'ablation' ? (
        <div className="workflow-card">
          <div className="workflow-title">
            <b>2</b>
            <span>Run the four replay variants</span>
          </div>
          <p className="step-help">
            Reuses the selected raw scan recording. The robot and LiDAR remain stopped.
          </p>
          <ol className="procedure-list">
            {TestGuides.ablation.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
          <button
            className="step-primary"
            disabled={busy || session?.state !== 'created'}
            onClick={RunAblation}
          >
            RUN ABLATION REPLAY
          </button>
        </div>
      ) : (
        <div className="workflow-card start-card">
          <div className="start-step">
            <div className="workflow-title">
              <b>2</b>
              <span>Start board data capture</span>
            </div>
            <p className="step-help">
              Creates isolated telemetry and raw-scan files for this trial.
            </p>
            <button
              disabled={busy || session?.state !== 'created'}
              onClick={() => SessionAction('start')}
            >
              START CAPTURE
            </button>
          </div>
          <div className="start-step">
            <div className="workflow-title">
              <b>3</b>
              <span>
                {runType === 'resource' ? 'Start mission after IDLE' : 'Start the LiDAR mission'}
              </span>
            </div>
            <p className="step-help">
              {runType === 'resource'
                ? 'Record the IDLE interval first; then start the mission for tracking states.'
                : 'Wait for a stable pose before executing the selected test.'}
            </p>
            <button
              disabled={busy || !capturing || Boolean(robot?.mission_running)}
              onClick={() => mission('start')}
            >
              START MISSION
            </button>
          </div>
        </div>
      )}

      {capturing && (
        <div className="workflow-card active-capture">
          <div className="workflow-title">
            <b>4</b>
            <span>Execute the {runType} test procedure</span>
          </div>

          <ol className="procedure-list">
            {activeGuide.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>

          {(
            ['ground_truth', 'route', 'kidnapped', 'dynamic_occluded'] as ExperimentRunType[]
          ).includes(runType) && (
            <div className="marker-form">
              <label>
                Marker ID
                <input value={markerId} onChange={(event) => setMarkerId(event.target.value)} />
              </label>
              <label>
                Zone
                <select value={markerZone} onChange={(event) => setMarkerZone(event.target.value)}>
                  <option value="room_1">Room 1</option>
                  <option value="doorway_transition">Doorway</option>
                  <option value="room_2">Room 2</option>
                </select>
              </label>
              <label>
                X (m)
                <input
                  type="number"
                  step="0.01"
                  value={markerX}
                  onChange={(event) => setMarkerX(event.target.value)}
                />
              </label>
              <label>
                Y (m)
                <input
                  type="number"
                  step="0.01"
                  value={markerY}
                  onChange={(event) => setMarkerY(event.target.value)}
                />
              </label>
              <label>
                Yaw (rad)
                <input
                  type="number"
                  step="0.01"
                  value={markerYaw}
                  onChange={(event) => setMarkerYaw(event.target.value)}
                />
              </label>
            </div>
          )}

          {runType === 'ground_truth' && (
            <div className="ground-truth-action">
              <div>
                <small>PLACEMENTS RECORDED</small>
                <b>{checkpointCount}/10</b>
              </div>
              <button
                className="highlight"
                disabled={checkpointCount >= 10}
                onClick={RecordCheckpoint}
              >
                RECORD PLACEMENT
              </button>
            </div>
          )}
          {(runType === 'route' || runType === 'dynamic_occluded') && (
            <>
              {runType === 'dynamic_occluded' && (
                <div className="dynamic-occlusion-card">
                  <div>
                    <small>DYNAMIC CROSSING</small>
                    <b>T0 · {pedestrianDirection.replaceAll('_', ' ')}</b>
                    <span>Required crossing time: 2.5–3.5 seconds</span>
                  </div>
                  <button
                    className="warning"
                    disabled={
                      dynamicCrossingStartedAt !== undefined ||
                      dynamicCrossingDuration !== undefined
                    }
                    onClick={() =>
                      RecordEvent('DYNAMIC_OCCLUSION_START', false, {
                        trigger_marker: 'T0',
                        pedestrian_direction: pedestrianDirection,
                      })
                    }
                  >
                    PERSON START
                  </button>
                  <button
                    className="stop"
                    disabled={dynamicCrossingStartedAt === undefined}
                    onClick={() =>
                      RecordEvent('DYNAMIC_OCCLUSION_END', false, {
                        trigger_marker: 'T0',
                        pedestrian_direction: pedestrianDirection,
                      })
                    }
                  >
                    PERSON END
                  </button>
                  <output
                    className={
                      dynamicCrossingDuration === undefined
                        ? ''
                        : dynamicCrossingDuration >= 2500 && dynamicCrossingDuration <= 3500
                          ? 'duration-pass'
                          : 'duration-fail'
                    }
                  >
                    {dynamicCrossingStartedAt
                      ? 'CROSSING…'
                      : dynamicCrossingDuration === undefined
                        ? 'NOT RECORDED'
                        : `${(dynamicCrossingDuration / 1000).toFixed(2)} s`}
                  </output>
                </div>
              )}
              <div className="event-actions">
                <button onClick={() => RecordEvent('ROUTE_START')}>ROUTE START</button>
                <button className="highlight" onClick={RecordCheckpoint}>
                  RECORD CHECKPOINT ({checkpointCount}/8)
                </button>
                <button onClick={() => RecordEvent('ROUTE_END')}>ROUTE END</button>
              </div>
            </>
          )}
          {runType === 'kidnapped' && (
            <div className="event-actions">
              <button className="warning" onClick={() => RecordEvent('KIDNAP_START')}>
                KIDNAP START
              </button>
              <button className="highlight" onClick={() => RecordEvent('KIDNAP_RELEASE', true)}>
                KIDNAP RELEASE + REFERENCE
              </button>
              <button onClick={RecordCheckpoint}>FINAL CHECKPOINT</button>
            </div>
          )}
          {runType === 'resource' && (
            <div className="resource-procedure">
              <div className="resource-repetition">
                <label>
                  Repetition being recorded
                  <select
                    value={resourceRepetition}
                    onChange={(event) => setResourceRepetition(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        Repetition {value}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <small>COMPLETED INTERVALS</small>
                  <b>{resourceMeasurementCount}/15</b>
                </div>
              </div>
              <div className="resource-intervals">
                <div>
                  <b>1. IDLE — 60 s</b>
                  <button
                    onClick={() =>
                      RecordEvent('RESOURCE_IDLE_START', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    START
                  </button>
                  <button
                    className="stop"
                    onClick={() =>
                      RecordEvent('RESOURCE_IDLE_END', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    END
                  </button>
                </div>
                <div>
                  <b>2. NORMAL TRACKING — 60 s</b>
                  <button
                    onClick={() =>
                      RecordEvent('RESOURCE_TRACKING_START', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    START
                  </button>
                  <button
                    className="stop"
                    onClick={() =>
                      RecordEvent('RESOURCE_TRACKING_END', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    END
                  </button>
                </div>
                <div>
                  <b>3. GLOBAL RELOCALIZATION — 60 s</b>
                  <button
                    onClick={() =>
                      RecordEvent('RESOURCE_GLOBAL_START', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    START
                  </button>
                  <button
                    className="stop"
                    onClick={() =>
                      RecordEvent('RESOURCE_GLOBAL_END', false, {
                        repetition: resourceRepetition,
                      })
                    }
                  >
                    END
                  </button>
                </div>
              </div>
              <p className="resource-note">
                Keep each interval between 55 and 65 seconds. Board telemetry records CPU, RAM,
                processing time, update rate, and binary size automatically.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="workflow-card">
        <div className="workflow-title">
          <b>5–8</b>
          <span>Stop, analyze, and finalize results</span>
        </div>
        <p className="step-help">
          {runType === 'ablation'
            ? 'Analyze the replay outputs, review all four variants, then finalize the immutable result.'
            : 'Stop the mission before capture, review the generated report after analysis, then finalize the immutable result.'}
        </p>
        <div className="ordered-actions finish-actions">
          {runType !== 'ablation' && (
            <>
              <button
                className="stop"
                disabled={busy || !capturing || !robot?.mission_running}
                onClick={() => mission('stop')}
              >
                5. STOP MISSION
              </button>
              <button
                className="stop"
                disabled={busy || !capturing || Boolean(robot?.mission_running)}
                onClick={() => SessionAction('stop')}
              >
                6. STOP CAPTURE
              </button>
            </>
          )}
          <button
            disabled={busy || session?.state !== 'stopped'}
            onClick={() => SessionAction('analyze')}
          >
            {runType === 'ablation' ? '3. ANALYZE' : '7. ANALYZE'}
          </button>
          <button
            disabled={busy || session?.state !== 'analyzed'}
            onClick={() => SessionAction('finalize')}
          >
            {runType === 'ablation' ? '4. FINALIZE' : '8. FINALIZE'}
          </button>
        </div>
        {session && (
          <div className="session-id">
            <b>Output:</b> EXPERIMENTS/Ouputs/{session.experiment_id}
          </div>
        )}
        {session?.error && <div className="experiment-error">{session.error}</div>}
      </div>

      {report && <pre className="report-preview">{JSON.stringify(report, null, 2)}</pre>}

      <div className="campaign-progress">
        <b>Campaign progress</b>
        <span>Ground truth {RunProgress('ground_truth')}/1</span>
        <span>Route nominal {Progress('nominal')}/10</span>
        <span>Route occluded {Progress('lidar_occluded_90')}/10</span>
        <span>Route furniture {Progress('furniture_changed')}/10</span>
        <span>Dynamic occluded {RunProgress('dynamic_occluded')}/10</span>
        <span>Kidnap same room {RunProgress('kidnapped', 'KIDNAP_SAME_ROOM')}/10</span>
        <span>Kidnap cross room {RunProgress('kidnapped', 'KIDNAP_CROSS_ROOM')}/10</span>
        <span>Ablation {RunProgress('ablation')}/10</span>
        <span>Resource campaign {RunProgress('resource')}/1</span>
      </div>
    </section>
  );
}

function App() {
  const [view, setView] = useState<'monitor' | 'experiment'>('monitor');
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
        setNotice(`${(msg.data as { command: string }).command} received by robot`);
      if (msg.type === 'mapping_status')
        setMappingState((msg.data as { state: MappingState }).state);
      if (msg.type === 'mapping_map') setMap(msg.data as MapData);
      if (msg.type === 'map_saved') {
        setSavedMap((msg.data as { name: string }).name);
        setNotice('Map saved, auto-aligned, and assigned metric X/Y coordinates');
      }
      if (msg.type === 'map_transfer_started')
        setNotice(`Sending map ${(msg.data as { name: string }).name}...`);
      if (msg.type === 'map_transfer_ack')
        setNotice(
          (msg.data as { success: boolean }).success
            ? 'Map installed on robot successfully'
            : 'Robot rejected map: validation failed',
        );
    };
    return () => socket.close();
  }, []);
  const robot = Object.values(robots)[0];
  const mission = async (action: 'start' | 'stop') => {
    if (!robot) return;
    setNotice(`Sending ${action}...`);
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
    if (!response.ok) setNotice(result.error ?? 'Mapping command failed');
    else if (action !== 'save') setNotice(`Mapping ${result.state}`);
  };
  const transferMap = async () => {
    if (!robot || !savedMap) return;
    setNotice(`Preparing transfer for ${savedMap}...`);
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
          <div className="view-tabs">
            <button
              className={view === 'monitor' ? 'active' : ''}
              onClick={() => setView('monitor')}
            >
              MONITORING
            </button>
            <button
              className={view === 'experiment' ? 'active' : ''}
              onClick={() => setView('experiment')}
            >
              TESTING
            </button>
          </div>
        </div>
        <span className={`connection ${robot?.online ? 'online' : ''}`}>
          {robot?.online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </header>
      <section className={`layout ${view === 'experiment' ? 'experiment-layout' : ''}`}>
        <div className="map">
          <MapView map={map} robot={robot} />
        </div>
        {view === 'monitor' ? (
          <aside>
            <div className="status-grid">
              <div className="card compact-card">
                <span>Mission</span>
                <strong>{robot?.mission_running ? 'RUNNING' : 'STOPPED'}</strong>
                <small>{robot?.mission_running ? 'LiDAR active' : 'LiDAR stopped'}</small>
              </div>
              <div className="card compact-card">
                <span>Mapping</span>
                <strong>{mappingState.toUpperCase()}</strong>
                <small>RF2O + SLAM</small>
              </div>
              <div className="card compact-card">
                <span>Robot</span>
                <strong>{robot?.robot_id || 'Waiting...'}</strong>
                <small>{robot?.online ? 'Connected' : 'Disconnected'}</small>
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
              <small>{robot?.pose?.valid ? 'Pose valid' : 'Pose not valid yet'}</small>
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
                SAVE + AUTO ALIGN
              </button>
              <button disabled={!robot?.online || !savedMap} onClick={transferMap}>
                TRANSFER MAP
              </button>
            </div>
            <p className="notice">{notice}</p>
          </aside>
        ) : (
          <ExperimentPanel robot={robot} mission={mission} setNotice={setNotice} />
        )}
      </section>
      {view === 'experiment' && <p className="global-notice">{notice}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
