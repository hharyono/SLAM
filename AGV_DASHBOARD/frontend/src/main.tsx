import { useEffect, useMemo, useRef, useState } from 'react';
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
type MapCatalogEntry = {
  name: string;
  active: boolean;
  width: number;
  height: number;
  resolution: number;
  origin: { x: number; y: number; yaw: number };
  binary_bytes: number;
  updated_unix_ms: number;
};
type ServerMessage =
  | { type: 'snapshot'; data: RobotStatus[] }
  | { type: 'robot_status'; data: RobotStatus }
  | { type: 'command_ack'; data: { command: string } }
  | { type: 'mapping_status'; data: { state: MappingState } }
  | { type: 'mapping_map'; data: MapData }
  | { type: 'map_saved'; data: { name: string; replaced?: boolean } }
  | { type: 'map_activated'; data: { name: string } }
  | { type: 'map_deleted'; data: { name: string } }
  | { type: 'map_transfer_started'; data: { name: string } }
  | {
      type: 'map_transfer_ack';
      data: {
        success: boolean;
        transfer_id: number;
        name?: string;
        activated?: boolean;
        error?: string;
      };
    }
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
type ExperimentMarker = {
  marker_id: string;
  zone: string;
  x: number;
  y: number;
  yaw: number;
};
type ExperimentSession = {
  experiment_id: string;
  condition: 'nominal' | 'lidar_occluded_90' | 'furniture_changed' | 'dynamic_occluded';
  run_type: ExperimentRunType;
  trial: number;
  route_id: string;
  zone: string;
  state: ExperimentState;
  created_unix_ms: number;
  status_count: number;
  checkpoint_count?: number;
  route_started?: boolean;
  route_ended?: boolean;
  recorded_marker_ids?: string[];
  checkpoint_estimates?: Record<string, Pose>;
  output_relative_path?: string;
  reference_marker?: ExperimentMarker;
  route_markers?: ExperimentMarker[];
  source_experiment_id?: string;
  error?: string;
};
type RouteMarkerDraft = {
  marker_id: string;
  zone: string;
  x: string;
  y: string;
  yawRadians: string;
  saved: boolean;
};

function InitialRouteMarkers(): RouteMarkerDraft[] {
  return Array.from({ length: 8 }, (_, index) => ({
    marker_id: `M${index + 1}`,
    zone: index < 3 ? 'room_1' : index < 5 ? 'doorway_transition' : 'room_2',
    x: '',
    y: '',
    yawRadians: '',
    saved: false,
  }));
}

const RouteMarkerStorageKey = 'luckfox.route-marker-drafts.v1';

function StoredRouteMarkers(): RouteMarkerDraft[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RouteMarkerStorageKey) || 'null');
    if (
      Array.isArray(stored) &&
      stored.length === 8 &&
      stored.every(
        (marker) =>
          typeof marker.marker_id === 'string' &&
          typeof marker.zone === 'string' &&
          typeof marker.x === 'string' &&
          typeof marker.y === 'string' &&
          typeof marker.yawRadians === 'string' &&
          typeof marker.saved === 'boolean',
      )
    )
      return stored as RouteMarkerDraft[];
  } catch {
    // Invalid browser state is safely replaced by a clean marker set.
  }
  return InitialRouteMarkers();
}
type ExperimentPreflight = {
  board_target: string;
  active_map?: string;
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

function MapView({ map, robot }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grayscalePixels = useMemo(
    () =>
      map ? Uint8Array.from(atob(map.pixels), (character) => character.charCodeAt(0)) : undefined,
    [map],
  );

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
  }, [grayscalePixels, map, robot]);

  return <canvas ref={canvasRef} width="900" height="650" />;
}

type ExperimentPanelProps = {
  robot?: RobotStatus;
  mission: (action: 'start' | 'stop') => Promise<void>;
  setNotice: (message: string) => void;
  preflight?: ExperimentPreflight;
  setPreflight: (preflight: ExperimentPreflight) => void;
};

async function JsonRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function ExperimentPanel({
  robot,
  mission,
  setNotice,
  preflight,
  setPreflight,
}: ExperimentPanelProps) {
  const [runType, setRunType] = useState<ExperimentRunType>('route');
  const [condition, setCondition] = useState<ExperimentSession['condition']>('nominal');
  const [routeId, setRouteId] = useState('R1_ROOM_1_TO_2');
  const [zone, setZone] = useState('cross_room');
  const [trial, setTrial] = useState(1);
  const [session, setSession] = useState<ExperimentSession>();
  const [sessions, setSessions] = useState<ExperimentSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [markerId, setMarkerId] = useState('M1');
  const [markerX, setMarkerX] = useState('1.65');
  const [markerY, setMarkerY] = useState('1.35');
  const [markerYawDegrees, setMarkerYawDegrees] = useState('85.1');
  const [markerZone, setMarkerZone] = useState('room_1');
  const [routeMarkers, setRouteMarkers] = useState<RouteMarkerDraft[]>(StoredRouteMarkers);
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
    if (active) {
      setSession(active);
      setRunType(active.run_type);
      setCondition(active.condition);
      setRouteId(active.route_id);
      setCheckpointCount(active.checkpoint_count ?? 0);
    } else {
      const resumable = list.find((item) => !['finalized', 'error'].includes(item.state));
      const updated = session
        ? list.find((item) => item.experiment_id === session.experiment_id)
        : undefined;
      const selected = resumable || updated;
      if (selected) {
        setSession(selected);
        setRunType(selected.run_type);
        setCondition(selected.condition);
        setRouteId(selected.route_id);
        setCheckpointCount(selected.checkpoint_count ?? 0);
      } else {
        setSession(undefined);
        setCheckpointCount(0);
      }
    }
    setSessions(list);
  };

  useEffect(() => {
    Refresh().catch((error) => setNotice(String(error)));
    const timer = window.setInterval(() => Refresh().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (runType === 'ground_truth') {
      setRouteId('GROUND_TRUTH_REPEAT');
      setZone('room_1');
      setMarkerZone('room_1');
      setMarkerId('M1');
      setMarkerX('1.65');
      setMarkerY('1.35');
      setMarkerYawDegrees('85.1');
    }
    if (runType === 'route') {
      setRouteId('R1_ROOM_1_TO_2');
    }
    if (runType === 'kidnapped') setRouteId('KIDNAP_SAME_ROOM');
    if (runType === 'dynamic_occluded') {
      setRouteId('R1_ROOM_1_TO_2');
    }
    if (runType === 'ablation') setRouteId('ABLATION_REPLAY');
    if (runType === 'resource') setRouteId('RESOURCE_SEQUENCE');
    if (runType === 'dynamic_occluded') setCondition('dynamic_occluded');
    else if (runType !== 'route') setCondition('nominal');
  }, [runType]);

  useEffect(() => {
    localStorage.setItem(RouteMarkerStorageKey, JSON.stringify(routeMarkers));
  }, [routeMarkers]);

  useEffect(() => {
    if (runType !== 'route' && runType !== 'dynamic_occluded') return;
    let active = true;
    JsonRequest<ExperimentMarker[]>(`/api/experiments/route-markers/${encodeURIComponent(routeId)}`)
      .then((markers) => {
        if (!active) return;
        setRouteMarkers(
          markers.map((marker) => ({
            marker_id: marker.marker_id,
            zone: marker.zone,
            x: String(marker.x),
            y: String(marker.y),
            yawRadians: String(marker.yaw),
            saved: true,
          })),
        );
        setNotice(`${routeId}: public ground-truth markers loaded`);
      })
      .catch((error) => {
        if (active) setNotice((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [routeId, runType]);

  useEffect(() => {
    if (sourceExperimentId) return;
    const candidate = sessions.find(
      (item) =>
        item.state === 'finalized' &&
        ['route', 'kidnapped', 'dynamic_occluded'].includes(item.run_type),
    );
    if (candidate) setSourceExperimentId(candidate.experiment_id);
  }, [sessions, sourceExperimentId]);

  const UpdateRouteMarker = (
    index: number,
    field: keyof Omit<RouteMarkerDraft, 'saved'>,
    value: string,
  ) =>
    setRouteMarkers((markers) =>
      markers.map((marker, markerIndex) =>
        markerIndex === index ? { ...marker, [field]: value, saved: false } : marker,
      ),
    );

  const SaveRouteMarker = (index: number) => {
    const marker = routeMarkers[index];
    if (!marker) return;
    if (!robot?.online || !robot.pose.valid) {
      setNotice(`${marker.marker_id}: wait for a VALID monitoring pose before saving`);
      return;
    }
    if (!marker.marker_id.trim()) {
      setNotice(`Marker ${index + 1}: enter a valid marker ID`);
      return;
    }
    if (
      routeMarkers.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          candidate.marker_id.trim().toUpperCase() === marker.marker_id.trim().toUpperCase(),
      )
    ) {
      setNotice(`Marker ID ${marker.marker_id} is duplicated`);
      return;
    }
    setRouteMarkers((markers) =>
      markers.map((candidate, markerIndex) =>
        markerIndex === index
          ? {
              ...candidate,
              x: String(robot.pose.x),
              y: String(robot.pose.y),
              yawRadians: String(robot.pose.yaw),
              saved: true,
            }
          : candidate,
      ),
    );
    setNotice(
      `${marker.marker_id} locked from monitoring: X ${robot.pose.x.toFixed(
        3,
      )} m, Y ${robot.pose.y.toFixed(3)} m, yaw ${robot.pose.yaw.toFixed(6)} rad`,
    );
  };

  const Run = async (action: () => Promise<void>, refreshAfter = true) => {
    setBusy(true);
    try {
      await action();
      if (refreshAfter) await Refresh();
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
          reference_marker:
            runType === 'ground_truth'
              ? {
                  marker_id: markerId,
                  zone,
                  x: Number(markerX),
                  y: Number(markerY),
                  yaw: (Number(markerYawDegrees) * Math.PI) / 180,
                }
              : undefined,
          route_markers:
            runType === 'route' || runType === 'dynamic_occluded'
              ? routeMarkers.map((marker) => ({
                  marker_id: marker.marker_id,
                  zone: marker.zone,
                  x: Number(marker.x),
                  y: Number(marker.y),
                  yaw: Number(marker.yawRadians),
                }))
              : undefined,
        }),
      });
      setSession(created);
      setSessions((current) => [
        created,
        ...current.filter((item) => item.experiment_id !== created.experiment_id),
      ]);
      setReport(undefined);
      setCheckpointCount(0);
      setResourceMeasurementCount(0);
      setDynamicCrossingStartedAt(undefined);
      setDynamicCrossingDuration(undefined);
      setNotice(`Session created: ${created.experiment_id}`);
    }, false);

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
      const updated = await JsonRequest<ExperimentSession>(
        `/api/experiments/${session.experiment_id}/event`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event,
            marker_id: markerId,
            x: includeReference ? Number(markerX) : undefined,
            y: includeReference ? Number(markerY) : undefined,
            yaw: includeReference ? (Number(markerYawDegrees) * Math.PI) / 180 : undefined,
            ...data,
          }),
        },
      );
      setSession(updated);
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

  const RecordCheckpoint = (configuredMarker?: ExperimentMarker) =>
    Run(async () => {
      if (!session) throw new Error('Start a capture session first');
      const replacing = Boolean(
        configuredMarker && session.recorded_marker_ids?.includes(configuredMarker.marker_id),
      );
      const updated = await JsonRequest<ExperimentSession>(
        `/api/experiments/${session.experiment_id}/checkpoint`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marker_id: configuredMarker?.marker_id || markerId,
            zone: configuredMarker?.zone || markerZone,
            x: configuredMarker?.x ?? Number(markerX),
            y: configuredMarker?.y ?? Number(markerY),
            yaw: configuredMarker?.yaw ?? (Number(markerYawDegrees) * Math.PI) / 180,
          }),
        },
      );
      setSession(updated);
      setCheckpointCount(updated.checkpoint_count ?? checkpointCount + 1);
      setNotice(
        `Checkpoint ${configuredMarker?.marker_id || markerId} ${
          replacing ? 'replaced' : 'recorded'
        }`,
      );
    });

  const UnlockCheckpoint = (configuredMarker: ExperimentMarker) =>
    Run(async () => {
      if (!session) throw new Error('Start a capture session first');
      const updated = await JsonRequest<ExperimentSession>(
        `/api/experiments/${session.experiment_id}/checkpoint/unlock`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marker_id: configuredMarker.marker_id }),
        },
      );
      setSession(updated);
      setCheckpointCount(updated.checkpoint_count ?? Math.max(0, checkpointCount - 1));
      setNotice(`${configuredMarker.marker_id} unlocked; its card is live and can be locked again`);
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
      setNotice('Preflight completed; selected public route markers remain locked');
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
  const pedestrianDirection = routeId === 'R2_ROOM_2_TO_1' ? 'H2_TO_H1' : 'H1_TO_H2';
  const routeMarkersReady = routeMarkers.every(
    (marker) =>
      marker.saved &&
      marker.marker_id.trim() &&
      marker.x.trim() &&
      marker.y.trim() &&
      marker.yawRadians.trim() &&
      [Number(marker.x), Number(marker.y), Number(marker.yawRadians)].every(Number.isFinite),
  );
  const configuredRouteMarkers = session?.route_markers || [];

  return (
    <section className="experiment-panel">
      <div className="experiment-heading experiment-status-only">
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
            {type.replace('_', ' ').toUpperCase()}
          </button>
        ))}
      </div>

      <div className="workflow-card preflight-step">
        <div className="workflow-title">
          <b>0</b>
          <span>Preflight</span>
        </div>
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
              <div>
                <b>Active map:</b> {preflight.active_map || 'unknown'}
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
          <span>Session setup</span>
        </div>
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
        {runType === 'ground_truth' && (
          <div className="ground-truth-reference-setup">
            <small>GROUND-TRUTH MARKER REFERENCE</small>
            <div className="marker-form">
              <label>
                Marker ID
                <input
                  value={markerId}
                  disabled={Boolean(session && !canCreate)}
                  onChange={(event) => setMarkerId(event.target.value)}
                />
              </label>
              <label>
                X (m)
                <input
                  type="number"
                  step="0.01"
                  value={markerX}
                  disabled={Boolean(session && !canCreate)}
                  onChange={(event) => setMarkerX(event.target.value)}
                />
              </label>
              <label>
                Y (m)
                <input
                  type="number"
                  step="0.01"
                  value={markerY}
                  disabled={Boolean(session && !canCreate)}
                  onChange={(event) => setMarkerY(event.target.value)}
                />
              </label>
              <label>
                Yaw (deg)
                <input
                  type="number"
                  step="0.1"
                  value={markerYawDegrees}
                  disabled={Boolean(session && !canCreate)}
                  onChange={(event) => setMarkerYawDegrees(event.target.value)}
                />
              </label>
            </div>
          </div>
        )}
        {(runType === 'route' || runType === 'dynamic_occluded') && (
          <div className="ground-truth-reference-setup">
            <div className="route-survey-controls">
              <button
                disabled={!robot?.online || Boolean(robot?.mission_running)}
                type="button"
                onClick={() => mission('start')}
              >
                START LIVE
              </button>
              <button
                className="stop"
                disabled={!robot?.online || !robot?.mission_running}
                type="button"
                onClick={() => mission('stop')}
              >
                STOP LIVE
              </button>
            </div>
            <div className="route-marker-grid">
              {routeMarkers.map((marker, index) => {
                const livePose = robot?.online ? robot.pose : undefined;
                const displayX = marker.saved
                  ? Number(marker.x)
                  : livePose?.valid
                    ? livePose.x
                    : undefined;
                const displayY = marker.saved
                  ? Number(marker.y)
                  : livePose?.valid
                    ? livePose.y
                    : undefined;
                const displayYaw = marker.saved
                  ? Number(marker.yawRadians)
                  : livePose?.valid
                    ? livePose.yaw
                    : undefined;
                return (
                  <div
                    className={`route-marker-card ${marker.saved ? 'marker-saved' : ''}`}
                    key={index}
                  >
                    <div className="route-marker-title">
                      <input
                        aria-label={`Marker ${index + 1} ID`}
                        value={marker.marker_id}
                        disabled={marker.saved}
                        onChange={(event) =>
                          UpdateRouteMarker(index, 'marker_id', event.target.value)
                        }
                      />
                      <span>{marker.saved ? 'LOCKED' : livePose?.valid ? 'LIVE' : 'NO POSE'}</span>
                    </div>
                    <label>
                      Zone
                      <select
                        value={marker.zone}
                        disabled={marker.saved}
                        onChange={(event) => UpdateRouteMarker(index, 'zone', event.target.value)}
                      >
                        <option value="room_1">Room 1</option>
                        <option value="doorway_transition">Doorway</option>
                        <option value="room_2">Room 2</option>
                      </select>
                    </label>
                    <div className="route-marker-values">
                      <label>
                        X (m)
                        <input readOnly value={displayX === undefined ? '' : displayX.toFixed(3)} />
                      </label>
                      <label>
                        Y (m)
                        <input readOnly value={displayY === undefined ? '' : displayY.toFixed(3)} />
                      </label>
                      <label>
                        Yaw (rad)
                        <input
                          readOnly
                          value={displayYaw === undefined ? '' : displayYaw.toFixed(6)}
                        />
                      </label>
                    </div>
                    <div className="route-marker-save">
                      <small>
                        {displayYaw === undefined
                          ? 'Waiting for valid monitoring pose'
                          : `${((displayYaw * 180) / Math.PI).toFixed(1)}° · score ${
                              livePose?.score.toFixed(3) ?? '—'
                            }`}
                      </small>
                      <button
                        className={marker.saved ? '' : 'highlight'}
                        disabled={marker.saved || !livePose?.valid}
                        type="button"
                        onClick={() => SaveRouteMarker(index)}
                      >
                        {marker.saved ? `${marker.marker_id} LOCKED` : `SAVE ${marker.marker_id}`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <button
          className="step-primary"
          disabled={
            busy ||
            !canCreate ||
            !preflightReady ||
            (runType === 'ablation' && !sourceExperimentId) ||
            ((runType === 'route' || runType === 'dynamic_occluded') && !routeMarkersReady)
          }
          onClick={CreateSession}
        >
          CREATE SESSION
        </button>
        {!preflightReady && <p className="gate-message">...</p>}
        {(runType === 'route' || runType === 'dynamic_occluded') && !routeMarkersReady && (
          <p className="gate-message">Save all 8 marker references before creating the session.</p>
        )}
      </div>

      {runType === 'ablation' ? (
        <div className="workflow-card">
          <div className="workflow-title">
            <b>2</b>
            <span>Ablation replay</span>
          </div>
          <button
            className="step-primary"
            disabled={busy || session?.state !== 'created'}
            onClick={RunAblation}
          >
            RUN REPLAY
          </button>
        </div>
      ) : (
        <div className="workflow-card start-card">
          <div className="start-step">
            <div className="workflow-title">
              <b>2</b>
              <span>Capture</span>
            </div>
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
              <span>{runType === 'resource' ? 'Mission after IDLE' : 'Mission'}</span>
            </div>
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
            <span>Run {runType.replace('_', ' ')}</span>
          </div>

          {runType === 'kidnapped' && (
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
                Yaw (deg)
                <input
                  type="number"
                  step="0.1"
                  value={markerYawDegrees}
                  onChange={(event) => setMarkerYawDegrees(event.target.value)}
                />
              </label>
            </div>
          )}

          {runType === 'ground_truth' && (
            <>
              {session?.reference_marker && (
                <div className="ground-truth-reference-live">
                  <div>
                    <span>X</span>
                    <b>{session.reference_marker.x.toFixed(2)} m</b>
                  </div>
                  <div>
                    <span>Y</span>
                    <b>{session.reference_marker.y.toFixed(2)} m</b>
                  </div>
                  <div>
                    <span>Yaw</span>
                    <b>{((session.reference_marker.yaw * 180) / Math.PI).toFixed(1)}°</b>
                  </div>
                </div>
              )}
              <div className="ground-truth-action">
                <div>
                  <small>PLACEMENTS RECORDED</small>
                  <b>{checkpointCount}/10</b>
                </div>
                <button
                  className="highlight"
                  disabled={checkpointCount >= 10}
                  onClick={() => RecordCheckpoint()}
                >
                  RECORD PLACEMENT
                </button>
              </div>
            </>
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
              <div className="route-checkpoint-grid">
                {configuredRouteMarkers.map((configuredMarker) => {
                  const recorded = Boolean(
                    session?.recorded_marker_ids?.includes(configuredMarker.marker_id),
                  );
                  const displayedPose = recorded
                    ? session?.checkpoint_estimates?.[configuredMarker.marker_id]
                    : robot?.pose;
                  return (
                    <button
                      className={recorded ? 'route-marker-locked' : 'route-marker-live'}
                      disabled={checkpointCount >= 8 && !recorded}
                      key={configuredMarker.marker_id}
                      onClick={() => {
                        if (!recorded) RecordCheckpoint(configuredMarker);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        if (recorded) UnlockCheckpoint(configuredMarker);
                      }}
                      title={
                        recorded
                          ? 'Double-click to unlock this checkpoint'
                          : 'Click to lock the current monitoring pose'
                      }
                    >
                      <b>
                        {recorded ? '🔒 LOCKED' : '● LIVE'} · {configuredMarker.marker_id}
                      </b>
                      <small>
                        X {displayedPose?.x.toFixed(3) ?? '—'} · Y{' '}
                        {displayedPose?.y.toFixed(3) ?? '—'}
                      </small>
                      <small>Yaw {displayedPose?.yaw.toFixed(6) ?? '—'} rad</small>
                      <small>
                        {recorded
                          ? 'DOUBLE-CLICK TO UNLOCK'
                          : `CLICK TO LOCK · SCORE ${displayedPose?.score.toFixed(3) ?? '—'}`}
                      </small>
                    </button>
                  );
                })}
              </div>
              <p className="gate-message">
                Locked {checkpointCount}/8. M1 is ROUTE START and M8 is ROUTE END automatically.
                Green cards show live Monitoring X/Y/yaw-rad. Click to lock; double-click a locked
                card to return it to live green. Current pose:{' '}
                {robot?.pose.valid ? 'VALID' : 'INVALID'} · score{' '}
                {robot?.pose.score.toFixed(3) ?? 'N/A'}.
              </p>
            </>
          )}
          {runType === 'kidnapped' && (
            <div className="event-actions">
              <button className="warning" onClick={() => RecordEvent('KIDNAP_START')}>
                KIDNAP START
              </button>
              <button className="highlight" onClick={() => RecordEvent('KIDNAP_RELEASE', true)}>
                RELEASE + REF
              </button>
              <button onClick={() => RecordCheckpoint()}>FINAL CHECKPOINT</button>
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
            </div>
          )}
        </div>
      )}

      <div className="workflow-card">
        <div className="workflow-title">
          <b>5–8</b>
          <span>Results</span>
        </div>
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
            <b>Output:</b> EXPERIMENTS/Ouputs/
            {session.output_relative_path || session.experiment_id}
          </div>
        )}
        {session?.error && <div className="experiment-error">{session.error}</div>}
      </div>

      {report && <pre className="report-preview">{JSON.stringify(report, null, 2)}</pre>}
    </section>
  );
}

function App() {
  const [view, setView] = useState<'monitor' | 'experiment'>('monitor');
  const [map, setMap] = useState<MapData>();
  const [robots, setRobots] = useState<Record<string, RobotStatus>>({});
  const [notice, setNotice] = useState('');
  const [mappingState, setMappingState] = useState<MappingState>('stopped');
  const [mapCatalog, setMapCatalog] = useState<MapCatalogEntry[]>([]);
  const [activeMap, setActiveMap] = useState<string>();
  const [selectedMap, setSelectedMap] = useState('');
  const [newMapName, setNewMapName] = useState('map_01');
  const [mapActivationPending, setMapActivationPending] = useState(false);
  const [experimentPreflight, setExperimentPreflight] = useState<ExperimentPreflight>();
  const refreshMapCatalog = async () => {
    const response = await fetch('/api/maps');
    const result = (await response.json()) as {
      active_map?: string;
      maps?: MapCatalogEntry[];
      error?: string;
    };
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const maps = result.maps || [];
    setMapCatalog(maps);
    setActiveMap(result.active_map);
    setSelectedMap((current) =>
      current && maps.some((entry) => entry.name === current)
        ? current
        : result.active_map || maps[0]?.name || '',
    );
  };
  useEffect(() => {
    fetch('/api/map')
      .then((r) => r.json() as Promise<MapData>)
      .then(setMap)
      .catch((e) => setNotice(String(e)));
  }, []);
  useEffect(() => {
    Promise.all([fetch('/api/mapping/status'), refreshMapCatalog()])
      .then(([response]) => response.json() as Promise<{ state: MappingState }>)
      .then((status) => {
        setMappingState(status.state);
      })
      .catch((error) => setNotice(String(error)));
  }, []);
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const handleMessage = (event: MessageEvent<string>) => {
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
        const { name, replaced } = msg.data as { name: string; replaced?: boolean };
        setSelectedMap(name);
        refreshMapCatalog().catch((error) => setNotice(String(error)));
        setNotice(
          replaced
            ? 'Map replaced; previous version archived and new map validated at origin 0,0'
            : 'Map saved, aligned, cropped, rebased to 0,0, and refreshed in backend',
        );
      }
      if (msg.type === 'map_deleted')
        refreshMapCatalog().catch((error) => setNotice(String(error)));
      if (msg.type === 'map_activated') {
        const name = (msg.data as { name: string }).name;
        setActiveMap(name);
        setSelectedMap(name);
        refreshMapCatalog().catch((error) => setNotice(String(error)));
      }
      if (msg.type === 'map_transfer_started')
        setNotice(`Sending map ${(msg.data as { name: string }).name}...`);
      if (msg.type === 'map_transfer_ack') {
        const ack = msg.data as {
          success: boolean;
          name?: string;
          activated?: boolean;
          error?: string;
        };
        setMapActivationPending(false);
        setNotice(
          ack.success
            ? ack.activated
              ? `Map ${ack.name} is active in backend and robot`
              : `Map ${ack.name || ''} installed on robot successfully`
            : ack.error || 'Robot rejected map: validation failed',
        );
      }
    };

    const connect = () => {
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onmessage = handleMessage;
      socket.onopen = () => {
        fetch('/api/map')
          .then((response) => response.json() as Promise<MapData>)
          .then(setMap)
          .catch(() => undefined);
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
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
    if (
      action === 'save' &&
      (!/^[a-zA-Z0-9_-]+$/.test(newMapName) ||
        mapCatalog.some((entry) => entry.name === newMapName))
    ) {
      setNotice('Use a new map name containing only letters, numbers, underscore, or dash');
      return;
    }
    const response = await fetch(`/api/mapping/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: action === 'save' ? JSON.stringify({ name: newMapName }) : undefined,
    });
    const result = (await response.json()) as { error?: string; state?: MappingState };
    if (!response.ok) setNotice(result.error ?? 'Mapping command failed');
    else if (action !== 'save') setNotice(`Mapping ${result.state}`);
  };
  const activateMap = async () => {
    if (!robot || !selectedMap) return;
    setMapActivationPending(true);
    setNotice(`Sending and activating ${selectedMap} on robot...`);
    const response = await fetch(`/api/maps/${selectedMap}/activate/${robot.robot_id}`, {
      method: 'POST',
    });
    if (!response.ok) {
      const result = (await response.json()) as { error: string };
      setNotice(result.error);
      setMapActivationPending(false);
    }
  };
  const replaceMap = async () => {
    if (
      !selectedMap ||
      selectedMap === activeMap ||
      !window.confirm(
        `Replace ${selectedMap} with the current mapping result? The previous version will be archived.`,
      )
    )
      return;
    setNotice(`Replacing ${selectedMap}...`);
    const response = await fetch('/api/mapping/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: selectedMap, replace: true }),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) setNotice(result.error || 'Map replacement failed');
  };
  const deleteMap = async () => {
    if (
      !selectedMap ||
      selectedMap === activeMap ||
      !window.confirm(
        `Delete ${selectedMap} from the catalog? It will be moved to a recoverable trash folder.`,
      )
    )
      return;
    setNotice(`Deleting ${selectedMap}...`);
    const response = await fetch(`/api/maps/${selectedMap}`, { method: 'DELETE' });
    const result = (await response.json()) as { error?: string; recoverable_path?: string };
    if (!response.ok) {
      setNotice(result.error || 'Map deletion failed');
      return;
    }
    await refreshMapCatalog();
    setNotice(`Map deleted from catalog; backup: maps/${result.recoverable_path}`);
  };
  return (
    <main>
      <header>
        <div>
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
                <b className="metric-secondary">
                  {robot?.pose ? robot.pose.yaw.toFixed(2) : '—'} rad
                </b>
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
            <div className="control-groups">
              <div className="control-group">
                <div className="control-group-title">
                  <span>MISSION CONTROL</span>
                  <small>Localization and LiDAR</small>
                </div>
                <div className="controls mission-controls">
                  <button
                    disabled={!robot?.online || robot?.mission_running}
                    onClick={() => mission('start')}
                  >
                    <span className="control-step">1</span>
                    <span>START MISSION</span>
                  </button>
                  <button
                    className="stop"
                    disabled={!robot?.online || !robot?.mission_running}
                    onClick={() => mission('stop')}
                  >
                    <span className="control-step">2</span>
                    <span>STOP MISSION</span>
                  </button>
                </div>
              </div>

              <div className="control-group">
                <div className="control-group-title">
                  <span>MAPPING CONTROL</span>
                  <small>Origin normalized to 0,0</small>
                </div>
                <div className="controls mapping-controls">
                  <button
                    disabled={!robot?.online || mappingState !== 'stopped'}
                    onClick={() => mappingAction('start')}
                  >
                    <span className="control-step">1</span>
                    <span>START MAPPING</span>
                  </button>
                  <button
                    disabled={
                      mappingState !== 'running' ||
                      !/^[a-zA-Z0-9_-]+$/.test(newMapName) ||
                      mapCatalog.some((entry) => entry.name === newMapName)
                    }
                    onClick={() => mappingAction('save')}
                  >
                    <span className="control-step">2</span>
                    <span>SAVE + AUTO ALIGN</span>
                  </button>
                  <button
                    className="stop"
                    disabled={mappingState === 'stopped' || mappingState === 'stopping'}
                    onClick={() => mappingAction('stop')}
                  >
                    <span className="control-step">3</span>
                    <span>STOP MAPPING</span>
                  </button>
                </div>
              </div>
              <div className="control-group map-selection-card">
                <div className="control-group-title">
                  <span>MAPPING SELECTION</span>
                  <small>{activeMap ? `Active: ${activeMap}` : 'No active map'}</small>
                </div>
                <label>
                  Name for SAVE + AUTO ALIGN
                  <input
                    value={newMapName}
                    placeholder="example: warehouse_floor_1"
                    onChange={(event) => setNewMapName(event.target.value)}
                  />
                </label>
                <label>
                  Saved maps ({mapCatalog.length})
                  <select
                    value={selectedMap}
                    onChange={(event) => setSelectedMap(event.target.value)}
                  >
                    {mapCatalog.length ? (
                      mapCatalog.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {entry.name}
                          {entry.active ? ' — ACTIVE' : ''}
                        </option>
                      ))
                    ) : (
                      <option value="">No saved map</option>
                    )}
                  </select>
                </label>
                {mapCatalog
                  .filter((entry) => entry.name === selectedMap)
                  .map((entry) => (
                    <div className="selected-map-details" key={entry.name}>
                      <b>{entry.name}</b>
                      <span>
                        {entry.width} × {entry.height} px · {entry.resolution.toFixed(3)} m/px
                      </span>
                      <span>{(entry.binary_bytes / 1024).toFixed(1)} KiB binary</span>
                    </div>
                  ))}
                <button
                  className="activate-map"
                  disabled={
                    !robot?.online ||
                    Boolean(robot?.mission_running) ||
                    mappingState !== 'stopped' ||
                    !selectedMap ||
                    mapActivationPending
                  }
                  onClick={activateMap}
                >
                  {mapActivationPending
                    ? 'ACTIVATING…'
                    : selectedMap === activeMap
                      ? 'SYNC ACTIVE MAP TO ROBOT'
                      : 'ACTIVATE MAP ON ROBOT'}
                </button>
                <div className="map-management-actions">
                  <button
                    className="replace-map"
                    disabled={
                      mappingState !== 'running' ||
                      !selectedMap ||
                      selectedMap === activeMap ||
                      mapActivationPending
                    }
                    onClick={replaceMap}
                  >
                    REPLACE SELECTED MAP
                  </button>
                  <button
                    className="delete-map"
                    disabled={
                      mappingState !== 'stopped' ||
                      !selectedMap ||
                      selectedMap === activeMap ||
                      mapActivationPending
                    }
                    onClick={deleteMap}
                  >
                    DELETE SELECTED MAP
                  </button>
                </div>
              </div>
            </div>
            <p className="notice">{notice}</p>
          </aside>
        ) : (
          <ExperimentPanel
            robot={robot}
            mission={mission}
            setNotice={setNotice}
            preflight={experimentPreflight}
            setPreflight={setExperimentPreflight}
          />
        )}
      </section>
      {view === 'experiment' && <p className="global-notice">{notice}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
