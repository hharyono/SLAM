import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AnalyzeExperiment } from './experiment-analysis.js';

const ExecFileAsync = promisify(execFile);

export type ExperimentCondition =
  'nominal' | 'lidar_occluded_90' | 'furniture_changed' | 'dynamic_occluded';
export type ExperimentRunType =
  'ground_truth' | 'route' | 'kidnapped' | 'dynamic_occluded' | 'ablation' | 'resource';
export type ExperimentState =
  | 'created'
  | 'starting'
  | 'capturing'
  | 'stopping'
  | 'stopped'
  | 'analyzed'
  | 'finalized'
  | 'error';

export type ExperimentRobotStatus = {
  robot_id: string;
  seq: number;
  timestamp_ms: number;
  pose: {
    x: number;
    y: number;
    yaw: number;
    score: number;
    valid: boolean;
    mode: 'global' | 'tracking';
  };
  mission_running: boolean;
  online: boolean;
  received_ms: number;
};

export type ExperimentSession = {
  schema: 'luckfox.experiment.session.v1';
  experiment_id: string;
  condition: ExperimentCondition;
  run_type: ExperimentRunType;
  trial: number;
  route_id: string;
  route_reference_id?: string;
  route_reference_name?: string;
  zone: string;
  ground_truth_method: string;
  robot_id: string;
  state: ExperimentState;
  created_unix_ms: number;
  started_unix_ms?: number;
  stopped_unix_ms?: number;
  analyzed_unix_ms?: number;
  finalized_unix_ms?: number;
  status_count: number;
  raw_scan_capture_enabled?: boolean;
  raw_scan_capture_target?: 'board' | 'backend';
  raw_scan_streamed_frames?: number;
  raw_scan_streamed_points?: number;
  board_tmp_available_kb_before_start?: number;
  board_tmp_available_kb_after_stop?: number;
  checkpoint_count?: number;
  route_started?: boolean;
  route_ended?: boolean;
  recorded_marker_ids?: string[];
  checkpoint_estimates?: Record<string, ExperimentRobotStatus['pose']>;
  output_relative_path?: string;
  reference_marker?: ExperimentMarker;
  route_markers?: ExperimentMarker[];
  dynamic_occlusion_markers?: ExperimentMarker[];
  dynamic_occlusion_completed_marker_ids?: string[];
  dynamic_occlusion_active_marker_id?: string;
  dynamic_occlusion_active_started_unix_ms?: number;
  dynamic_occlusion_durations_ms?: Record<string, number>;
  dynamic_object_detection_required?: boolean;
  kidnap_start_marker?: ExperimentMarker;
  kidnap_target_marker?: ExperimentMarker;
  kidnap_release_unix_ms?: number;
  kidnap_recovery_observed?: boolean;
  kidnap_auto_checkpoint_unix_ms?: number;
  source_experiment_id?: string;
  ablation_execution_target?: AblationExecutionTarget;
  ablation_completed_variants?: string[];
  resource_mode?: 'live_tracking' | 'live_endurance' | 'replay';
  resource_replay_pacing?: 'recorded';
  resource_active_phase?: string;
  resource_active_started_unix_ms?: number;
  resource_completed_phases?: string[];
  error?: string;
};

export type AblationSource = {
  experiment_id: string;
  platform: string;
  condition: ExperimentCondition;
  run_type: ExperimentRunType;
  route_id: string;
  collection: 'accepted';
  raw_scan_bytes: number;
  raw_scan_schema: 'luckfox.raw-scan.csv.v1';
  map_name: string;
  map_sha256: string;
  source_revision: string;
  replay_binary_sha256: string;
  readiness: {
    finalized: true;
    raw_scan: true;
    map_hash: true;
    telemetry: true;
    firmware_format: true;
    replay_binary: true;
  };
};

export type AblationExecutionTarget = 'host' | 'rv1103' | 'rv1106';

export type AblationTargetStatus = {
  target: AblationExecutionTarget;
  label: string;
  ready: boolean;
  execution_location: 'backend' | 'board';
  board_target?: string;
  architecture?: string;
  replay_binary_sha256?: string;
  reason?: string;
};

export type ExperimentMarker = {
  marker_id: string;
  zone: string;
  x: number;
  y: number;
  yaw: number;
};

export type CreateSessionInput = {
  condition: string;
  run_type: string;
  trial: number;
  route_id?: string;
  route_reference_id?: string;
  route_reference_name?: string;
  zone?: string;
  ground_truth_method?: string;
  robot_id?: string;
  source_experiment_id?: string;
  ablation_execution_target?: string;
  resource_mode?: string;
  reference_marker?: Partial<ExperimentMarker>;
  route_markers?: Array<Partial<ExperimentMarker>>;
  kidnap_start_marker?: Partial<ExperimentMarker>;
  kidnap_target_marker?: Partial<ExperimentMarker>;
};

type ExperimentManagerOptions = {
  repoRoot: string;
  outputRoot: string;
  boardSshTarget: string;
  boardSshKey: string;
  ablationBoardTargets?: Partial<Record<'rv1103' | 'rv1106', string>>;
  notify: (session: ExperimentSession) => void;
};

const Conditions = new Set<ExperimentCondition>([
  'nominal',
  'lidar_occluded_90',
  'furniture_changed',
  'dynamic_occluded',
]);
const RunTypes = new Set<ExperimentRunType>([
  'ground_truth',
  'route',
  'kidnapped',
  'dynamic_occluded',
  'ablation',
  'resource',
]);
const OutputFolderByRunType: Record<ExperimentRunType, string> = {
  ground_truth: 'GROUND TRUTH',
  route: 'ROUTE',
  kidnapped: 'KIDNAPPED',
  dynamic_occluded: 'DYNAMIC OCCLUDED',
  ablation: 'ABLATION',
  resource: 'RESOURCE',
};

export function ExperimentOutputFolder(runType: ExperimentRunType): string {
  return OutputFolderByRunType[runType];
}
const Routes = new Set([
  'R1_ROOM_1_TO_2',
  'R2_ROOM_2_TO_1',
  'GROUND_TRUTH_REPEAT',
  'KIDNAP_SAME_ROOM',
  'KIDNAP_CROSS_ROOM',
  'ABLATION_REPLAY',
  'RESOURCE_SEQUENCE',
]);
const Zones = new Set(['room_1', 'doorway_transition', 'room_2', 'cross_room']);
const ReplayEnvironmentNames = {
  LUCKFOX_MINIMUM_RANGE_M: 'minimum_range_m',
  LUCKFOX_MAXIMUM_RANGE_M: 'maximum_range_m',
  LUCKFOX_LINEAR_WINDOW_M: 'linear_window_m',
  LUCKFOX_ANGULAR_WINDOW_RAD: 'angular_window_rad',
  LUCKFOX_LINEAR_STEP_M: 'linear_step_m',
  LUCKFOX_ANGULAR_STEP_RAD: 'angular_step_rad',
  LUCKFOX_MINIMUM_SCORE: 'minimum_score',
  LUCKFOX_LOST_AFTER_REJECTIONS: 'lost_after_rejections',
  LUCKFOX_RECOVERY_CONFIRMATIONS: 'recovery_confirmations',
} as const;
const FactorialReplayVariants = [
  'local_only_single',
  'local_only_multi',
  'local_global_single',
  'local_global_multi',
] as const;
const SelectedProductionReplayVariant = 'local_global_multi' as const;
const Events = new Set([
  'ROUTE_START',
  'ROUTE_END',
  'KIDNAP_START',
  'KIDNAP_RELEASE',
  'KIDNAP_AUTO_CHECKPOINT',
  'NOTE',
  'ANOMALY',
  'ROBOT_CONNECTED',
  'ROBOT_DISCONNECTED',
  'MISSION_START_SENT',
  'MISSION_STOP_SENT',
  'MISSION_ACK',
  'CHECKPOINT_REPLACED',
  'CHECKPOINT_UNLOCKED',
  'RESOURCE_IDLE_START',
  'RESOURCE_IDLE_END',
  'RESOURCE_TRACKING_R1_START',
  'RESOURCE_TRACKING_R1_END',
  'RESOURCE_TRACKING_R2_START',
  'RESOURCE_TRACKING_R2_END',
  'RESOURCE_ENDURANCE_START',
  'RESOURCE_ENDURANCE_END',
  'DYNAMIC_OCCLUSION_START',
  'DYNAMIC_OCCLUSION_END',
]);

function SafeText(value: unknown, maximum = 160): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, maximum);
}

function ParseMarker(
  marker: Partial<ExperimentMarker> | undefined,
  label: string,
): ExperimentMarker {
  const markerId = SafeText(marker?.marker_id, 40);
  const zone = SafeText(marker?.zone, 32);
  const x = Number(marker?.x);
  const y = Number(marker?.y);
  const yaw = Number(marker?.yaw);
  if (!markerId) throw new Error(`${label} marker ID is required`);
  if (!Zones.has(zone)) throw new Error(`${label} marker has an invalid zone`);
  if (![x, y, yaw].every(Number.isFinite))
    throw new Error(`${label} marker requires finite X, Y, and yaw values`);
  return { marker_id: markerId, zone, x, y, yaw };
}

function FileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ReadFilePrefix(file: string, maximumBytes: number): string {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(maximumBytes, fs.statSync(file).size));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function HeadingErrorDegrees(estimate: number, reference: number): number {
  return (
    (Math.abs(Math.atan2(Math.sin(estimate - reference), Math.cos(estimate - reference))) * 180) /
    Math.PI
  );
}

function AppendJsonLine(file: string, value: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function WalkFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? WalkFiles(target) : [target];
  });
}

function FindExperimentDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    if (fs.existsSync(path.join(directory, 'config', 'session.json'))) {
      found.push(directory);
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
  }
  return found;
}

function TimestampId(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export class ExperimentManager {
  private readonly RepoRoot: string;
  private readonly OutputRoot: string;
  private readonly BoardSshTarget: string;
  private readonly BoardSshKey: string;
  private readonly AblationBoardTargets: Record<'rv1103' | 'rv1106', string>;
  private readonly Notify: (session: ExperimentSession) => void;
  private ActiveExperimentId?: string;
  private PreviousSequence?: number;
  private PreviousRawScanSequence?: number;
  private RawScanStreamedFrames = 0;
  private RawScanStreamedPoints = 0;
  private readonly DynamicOcclusionTimers = new Map<string, NodeJS.Timeout>();
  private readonly AblationAbortControllers = new Map<string, AbortController>();
  private readonly AblationCancellations = new Set<string>();

  constructor(options: ExperimentManagerOptions) {
    this.RepoRoot = options.repoRoot;
    this.OutputRoot = options.outputRoot;
    this.BoardSshTarget = options.boardSshTarget;
    this.BoardSshKey = options.boardSshKey;
    this.AblationBoardTargets = {
      rv1103: options.ablationBoardTargets?.rv1103 || options.boardSshTarget,
      rv1106: options.ablationBoardTargets?.rv1106 || 'root@192.168.1.24',
    };
    this.Notify = options.notify;
    fs.mkdirSync(this.OutputRoot, { recursive: true });
    for (const folder of Object.values(OutputFolderByRunType))
      fs.mkdirSync(path.join(this.OutputRoot, folder), { recursive: true });
    for (const session of this.List()) {
      if (
        session.state === 'starting' ||
        session.state === 'capturing' ||
        session.state === 'stopping'
      ) {
        this.ActiveExperimentId = session.experiment_id;
        if (session.dynamic_occlusion_active_marker_id) this.ScheduleDynamicOcclusionEnd(session);
        break;
      }
    }
  }

  List(): ExperimentSession[] {
    if (!fs.existsSync(this.OutputRoot)) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(this.OutputRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.OutputRoot, entry.name);
      const legacyFile = path.join(directory, 'config', 'session.json');
      if (fs.existsSync(legacyFile)) {
        files.push(legacyFile);
        continue;
      }
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const categorizedFile = path.join(directory, child.name, 'config', 'session.json');
        if (fs.existsSync(categorizedFile)) files.push(categorizedFile);
      }
    }
    return files
      .flatMap((file) => {
        try {
          return [JSON.parse(fs.readFileSync(file, 'utf8')) as ExperimentSession];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.created_unix_ms - left.created_unix_ms);
  }

  ListAblationSources(): AblationSource[] {
    const sources: AblationSource[] = [];
    const acceptedRoot = path.join(path.dirname(this.OutputRoot), 'Accepted');
    const replayBinary = path.join(this.RepoRoot, 'LUCKFOX_LOCALIZER', 'build', 'localize_replay');
    if (
      !fs.existsSync(acceptedRoot) ||
      !fs.existsSync(replayBinary) ||
      (fs.statSync(replayBinary).mode & 0o111) === 0
    )
      return sources;
    const replayBinarySha256 = FileSha256(replayBinary);
    for (const directory of FindExperimentDirectories(acceptedRoot)) {
      const sessionFile = path.join(directory, 'config', 'session.json');
      const rawScan = path.join(directory, 'raw', 'raw_scans.csv');
      const mapFile = path.join(directory, 'config', 'map.json');
      const telemetry = path.join(directory, 'raw', 'telemetry.jsonl');
      if (
        !fs.existsSync(rawScan) ||
        fs.statSync(rawScan).size === 0 ||
        !fs.existsSync(mapFile) ||
        !fs.existsSync(telemetry)
      )
        continue;
      try {
        const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as ExperimentSession;
        const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as {
          name?: string;
          path?: string;
          sha256: string;
        };
        const rawPrefix = ReadFilePrefix(rawScan, 4096);
        const [rawHeader, firstRawRow] = rawPrefix.split(/\r?\n/);
        const rawValues = firstRawRow?.split(',').map(Number) || [];
        const telemetryPrefix = ReadFilePrefix(telemetry, 512 * 1024);
        const telemetryRows = telemetryPrefix
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>];
            } catch {
              return [];
            }
          });
        const parameters = telemetryRows.find(
          (row) => row.schema === 'luckfox.localization.config.v1',
        );
        const initialPose = telemetryRows.find(
          (row) => row.schema === 'luckfox.localization.scan.v1' && row.accepted === true,
        );
        const resolvedMap = path.resolve(String(map.path || ''));
        const relative = path.relative(acceptedRoot, directory).split(path.sep);
        const platform = /^RV\d+$/i.test(relative[0] || '')
          ? relative[0]!.toUpperCase()
          : 'UNCLASSIFIED';
        if (
          session.state !== 'finalized' ||
          !['route', 'kidnapped', 'dynamic_occluded'].includes(session.run_type) ||
          !/^[a-f0-9]{64}$/i.test(map.sha256) ||
          rawHeader !== 'scan_sequence,timestamp_ns,angle_rad,range_m,intensity' ||
          rawValues.length !== 5 ||
          !rawValues.every(Number.isFinite) ||
          !parameters ||
          !Object.values(ReplayEnvironmentNames).every((name) =>
            Number.isFinite(Number(parameters[name])),
          ) ||
          !initialPose ||
          ![initialPose.x_m, initialPose.y_m, initialPose.yaw_rad].every((value) =>
            Number.isFinite(Number(value)),
          ) ||
          !resolvedMap.startsWith(`${this.RepoRoot}${path.sep}`) ||
          !fs.existsSync(resolvedMap) ||
          FileSha256(resolvedMap) !== map.sha256
        )
          continue;
        sources.push({
          experiment_id: session.experiment_id,
          platform,
          condition: session.condition,
          run_type: session.run_type,
          route_id: session.route_id,
          collection: 'accepted',
          raw_scan_bytes: fs.statSync(rawScan).size,
          raw_scan_schema: 'luckfox.raw-scan.csv.v1',
          map_name:
            map.name ||
            (map.path ? path.basename(map.path, path.extname(map.path)) : 'unknown_map'),
          map_sha256: map.sha256,
          source_revision: session.experiment_id.split('_').at(-1) || 'unknown',
          replay_binary_sha256: replayBinarySha256,
          readiness: {
            finalized: true,
            raw_scan: true,
            map_hash: true,
            telemetry: true,
            firmware_format: true,
            replay_binary: true,
          },
        });
      } catch {
        // An incomplete candidate is omitted rather than offered to the operator.
      }
    }
    return sources.sort(
      (left, right) =>
        left.platform.localeCompare(right.platform) ||
        right.experiment_id.localeCompare(left.experiment_id),
    );
  }

  ListResourceReplaySources(): AblationSource[] {
    return this.ListAblationSources().filter(
      (source) => source.platform === 'RV1103' && ['route', 'kidnapped'].includes(source.run_type),
    );
  }

  async ListAblationTargets(): Promise<AblationTargetStatus[]> {
    const hostBinary = path.join(this.RepoRoot, 'LUCKFOX_LOCALIZER', 'build', 'localize_replay');
    const hostReady = fs.existsSync(hostBinary) && (fs.statSync(hostBinary).mode & 0o111) !== 0;
    const targets: AblationTargetStatus[] = [
      {
        target: 'host',
        label: 'PC',
        ready: hostReady,
        execution_location: 'backend',
        replay_binary_sha256: hostReady ? FileSha256(hostBinary) : undefined,
        reason: hostReady ? undefined : 'Host localize_replay is unavailable',
      },
    ];
    for (const target of ['rv1103', 'rv1106'] as const) {
      const boardTarget = this.AblationBoardTargets[target];
      try {
        const output = await this.RunSshTarget(
          boardTarget,
          `set -eu
test -x /usr/bin/localize_replay
printf 'architecture='; uname -m
printf 'sha256='; sha256sum /usr/bin/localize_replay | awk '{ print $1 }'
printf 'available_kb='; df -k /tmp | awk 'NR == 2 { print $4 }'`,
          5_000,
        );
        const values = Object.fromEntries(
          output
            .trim()
            .split(/\r?\n/)
            .map((line) => line.split('=', 2)),
        );
        targets.push({
          target,
          label: target.toUpperCase(),
          ready:
            values.architecture === 'armv7l' &&
            /^[a-f0-9]{64}$/i.test(values.sha256 || '') &&
            Number(values.available_kb) >= 8 * 1024,
          execution_location: 'board',
          board_target: boardTarget,
          architecture: values.architecture,
          replay_binary_sha256: values.sha256,
          reason:
            Number(values.available_kb) < 8 * 1024
              ? 'Board /tmp has less than 8 MiB available'
              : undefined,
        });
      } catch (error) {
        targets.push({
          target,
          label: target.toUpperCase(),
          ready: false,
          execution_location: 'board',
          board_target: boardTarget,
          reason: (error as Error).message.split(/\r?\n/, 1)[0],
        });
      }
    }
    return targets;
  }

  Get(experimentId: string): ExperimentSession {
    this.ValidateExperimentId(experimentId);
    const file = this.SessionFile(experimentId);
    if (!fs.existsSync(file)) throw new Error('Experiment not found');
    const session = JSON.parse(fs.readFileSync(file, 'utf8')) as ExperimentSession;
    if (['route', 'dynamic_occluded'].includes(session.run_type) && !session.checkpoint_estimates) {
      const checkpointFile = path.join(this.Directory(experimentId), 'raw', 'ground_truth.jsonl');
      const estimates: Record<string, ExperimentRobotStatus['pose']> = {};
      if (fs.existsSync(checkpointFile)) {
        for (const line of fs.readFileSync(checkpointFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
          const row = JSON.parse(line) as {
            marker_id: string;
            estimate: ExperimentRobotStatus['pose'];
          };
          estimates[row.marker_id] = row.estimate;
        }
      }
      session.checkpoint_estimates = estimates;
    }
    return session;
  }

  GetActive(): ExperimentSession | undefined {
    if (!this.ActiveExperimentId) return undefined;
    try {
      return this.Get(this.ActiveExperimentId);
    } catch (error) {
      if ((error as Error).message !== 'Experiment not found') throw error;
      this.ActiveExperimentId = undefined;
      return undefined;
    }
  }

  Create(input: CreateSessionInput): ExperimentSession {
    if (this.ActiveExperimentId) throw new Error('Another experiment is still active');
    if (!Conditions.has(input.condition as ExperimentCondition))
      throw new Error('Invalid condition');
    if (!RunTypes.has(input.run_type as ExperimentRunType)) throw new Error('Invalid run type');
    if (!Number.isInteger(input.trial) || input.trial < 0 || input.trial > 999)
      throw new Error('Trial must be an integer from 0 to 999');
    const runType = input.run_type as ExperimentRunType;
    if (runType === 'dynamic_occluded' && input.condition !== 'dynamic_occluded')
      throw new Error('The dynamic_occluded test must use the dynamic_occluded condition');
    if (runType === 'route' && input.condition === 'dynamic_occluded')
      throw new Error('Use the standalone dynamic_occluded test for moving-person trials');
    if (!['route', 'dynamic_occluded'].includes(runType) && input.condition !== 'nominal')
      throw new Error('Ground truth, kidnapped, ablation, and resource tests must use nominal');
    const defaultRoute = {
      ground_truth: 'GROUND_TRUTH_REPEAT',
      route: 'R1_ROOM_1_TO_2',
      kidnapped: 'KIDNAP_SAME_ROOM',
      dynamic_occluded: 'R1_ROOM_1_TO_2',
      ablation: 'ABLATION_REPLAY',
      resource: 'RESOURCE_SEQUENCE',
    }[runType];
    const routeId = SafeText(input.route_id || defaultRoute, 40);
    const routeReferenceId = SafeText(input.route_reference_id, 64) || undefined;
    const routeReferenceName = SafeText(input.route_reference_name, 80) || undefined;
    const zone = SafeText(input.zone || (runType === 'ground_truth' ? 'room_1' : 'cross_room'), 32);
    if (!Routes.has(routeId)) throw new Error('Invalid route ID');
    if (!Zones.has(zone)) throw new Error('Invalid zone');
    let referenceMarker: ExperimentMarker | undefined;
    let routeMarkers: ExperimentMarker[] | undefined;
    let dynamicOcclusionMarkers: ExperimentMarker[] | undefined;
    let kidnapStartMarker: ExperimentMarker | undefined;
    let kidnapTargetMarker: ExperimentMarker | undefined;
    if (runType === 'ground_truth') {
      const markerId = SafeText(input.reference_marker?.marker_id || 'M1', 40);
      const markerZone = SafeText(input.reference_marker?.zone || zone, 32);
      const x = Number(input.reference_marker?.x ?? 1.65);
      const y = Number(input.reference_marker?.y ?? 1.35);
      const yaw = Number(input.reference_marker?.yaw ?? (85.1 * Math.PI) / 180);
      if (!markerId) throw new Error('Ground-truth marker ID is required');
      if (!Zones.has(markerZone)) throw new Error('Invalid ground-truth marker zone');
      if (![x, y, yaw].every(Number.isFinite))
        throw new Error('Ground-truth marker X, Y, and yaw must be finite numbers');
      referenceMarker = { marker_id: markerId, zone: markerZone, x, y, yaw };
    }
    if (['route', 'dynamic_occluded'].includes(runType)) {
      if (!Array.isArray(input.route_markers) || input.route_markers.length !== 8)
        throw new Error('A route session requires exactly 8 marker references');
      routeMarkers = input.route_markers.map((marker, index) => {
        const markerId = SafeText(marker.marker_id, 40);
        const markerZone = SafeText(marker.zone, 32);
        const x = Number(marker.x);
        const y = Number(marker.y);
        const yaw = Number(marker.yaw);
        if (!markerId) throw new Error(`Route marker ${index + 1} requires an ID`);
        if (!Zones.has(markerZone)) throw new Error(`Route marker ${markerId} has an invalid zone`);
        if (![x, y, yaw].every(Number.isFinite))
          throw new Error(`Route marker ${markerId} requires finite X, Y, and yaw values`);
        return { marker_id: markerId, zone: markerZone, x, y, yaw };
      });
      if (new Set(routeMarkers.map((marker) => marker.marker_id)).size !== 8)
        throw new Error('Route marker IDs must be unique');
      if (runType === 'dynamic_occluded') {
        const expectedIds = new Set(['M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
        dynamicOcclusionMarkers = routeMarkers.filter((marker) =>
          expectedIds.has(marker.marker_id),
        );
        if (
          dynamicOcclusionMarkers.length !== 6 ||
          new Set(dynamicOcclusionMarkers.map((marker) => marker.marker_id)).size !== 6
        )
          throw new Error('Dynamic occlusion requires physical markers M2 through M7');
      }
    }
    if (runType === 'kidnapped') {
      kidnapStartMarker = ParseMarker(input.kidnap_start_marker, 'Kidnap start (A)');
      kidnapTargetMarker = ParseMarker(input.kidnap_target_marker, 'Kidnap target (B)');
      if (kidnapStartMarker.marker_id === kidnapTargetMarker.marker_id)
        throw new Error('Kidnap markers A and B must be different');
      const expectedRoute =
        kidnapStartMarker.zone === kidnapTargetMarker.zone
          ? 'KIDNAP_SAME_ROOM'
          : 'KIDNAP_CROSS_ROOM';
      if (routeId !== expectedRoute)
        throw new Error(
          `Kidnap route must be ${expectedRoute} for ${kidnapStartMarker.marker_id} → ${kidnapTargetMarker.marker_id}`,
        );
    }
    const sourceExperimentId = SafeText(input.source_experiment_id, 160) || undefined;
    const resourceMode = (SafeText(input.resource_mode, 16) || 'live_tracking') as
      'live_tracking' | 'live_endurance' | 'replay';
    if (
      runType === 'resource' &&
      !['live_tracking', 'live_endurance', 'replay'].includes(resourceMode)
    )
      throw new Error('Resource mode must be live_tracking, live_endurance, or replay');
    const ablationExecutionTarget = (SafeText(input.ablation_execution_target, 16) ||
      'host') as AblationExecutionTarget;
    if (runType === 'ablation') {
      if (!sourceExperimentId) throw new Error('A source experiment is required for ablation');
      if (!['host', 'rv1103', 'rv1106'].includes(ablationExecutionTarget))
        throw new Error('Invalid ablation execution target');
      if (!this.ListAblationSources().some((source) => source.experiment_id === sourceExperimentId))
        throw new Error('The source is not an eligible Accepted ablation recording');
      const sourceDirectory = this.ResolveAblationSourceDirectory(sourceExperimentId);
      const source = JSON.parse(
        fs.readFileSync(path.join(sourceDirectory, 'config', 'session.json'), 'utf8'),
      ) as ExperimentSession;
      if (source.state !== 'finalized')
        throw new Error('The ablation source recording must be finalized');
      const sourceRawScan = path.join(sourceDirectory, 'raw', 'raw_scans.csv');
      if (!fs.existsSync(sourceRawScan) || fs.statSync(sourceRawScan).size === 0)
        throw new Error('The source experiment has no raw scan recording');
    }
    if (runType === 'resource' && resourceMode === 'replay') {
      if (!sourceExperimentId)
        throw new Error('Select an Accepted RV1103 dataset for Resource Replay');
      if (
        !this.ListResourceReplaySources().some(
          (source) => source.experiment_id === sourceExperimentId,
        )
      )
        throw new Error('The source is not an eligible Accepted RV1103 replay dataset');
    }
    const commit = this.GitValue(['rev-parse', '--short=12', 'HEAD']) || 'no_commit';
    const now = new Date();
    const experimentId = `${TimestampId(now)}_${input.condition}_${runType}_${String(input.trial).padStart(2, '0')}_${commit}`;
    const outputFolder = ExperimentOutputFolder(runType);
    const directory = path.join(this.OutputRoot, outputFolder, experimentId);
    // Output folders may be removed when an operator clears a previous
    // campaign while the backend is still running. Recreate the full category
    // path at session creation time instead of relying only on startup setup.
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['config', 'raw', 'processed', 'tables', 'plots'])
      fs.mkdirSync(path.join(directory, name));
    for (const name of [
      'backend_status.jsonl',
      'backend_arrival.jsonl',
      'operator_events.jsonl',
      'ground_truth.jsonl',
    ])
      fs.writeFileSync(path.join(directory, 'raw', name), '', { flag: 'wx' });
    const session: ExperimentSession = {
      schema: 'luckfox.experiment.session.v1',
      experiment_id: experimentId,
      condition: input.condition as ExperimentCondition,
      run_type: runType,
      trial: input.trial,
      route_id: routeId,
      route_reference_id: routeReferenceId,
      route_reference_name: routeReferenceName,
      zone,
      ground_truth_method: SafeText(input.ground_truth_method || 'surveyed_floor_markers', 80),
      robot_id: SafeText(input.robot_id || 'AGV-001', 32),
      state: 'created',
      created_unix_ms: now.getTime(),
      status_count: 0,
      raw_scan_capture_enabled: runType === 'route' || runType === 'kidnapped',
      raw_scan_capture_target:
        runType === 'route' || runType === 'kidnapped' ? 'backend' : undefined,
      checkpoint_count: 0,
      route_started: false,
      route_ended: false,
      recorded_marker_ids: [],
      checkpoint_estimates: {},
      output_relative_path: path.join(outputFolder, experimentId),
      reference_marker: referenceMarker,
      route_markers: routeMarkers,
      dynamic_occlusion_markers: dynamicOcclusionMarkers,
      dynamic_occlusion_completed_marker_ids: [],
      dynamic_occlusion_durations_ms: {},
      dynamic_object_detection_required: runType === 'dynamic_occluded',
      kidnap_start_marker: kidnapStartMarker,
      kidnap_target_marker: kidnapTargetMarker,
      source_experiment_id: sourceExperimentId,
      ablation_execution_target:
        runType === 'ablation'
          ? ablationExecutionTarget
          : runType === 'resource' && resourceMode === 'replay'
            ? 'rv1103'
            : undefined,
      ablation_completed_variants:
        runType === 'ablation' || (runType === 'resource' && resourceMode === 'replay')
          ? []
          : undefined,
      resource_mode: runType === 'resource' ? resourceMode : undefined,
      resource_replay_pacing:
        runType === 'resource' && resourceMode === 'replay' ? 'recorded' : undefined,
    };
    this.WriteSession(session);
    const sourceConfig = path.join(
      this.RepoRoot,
      'RV1106_BUILDROOT/package/luckfox-localizer/localize_uart.default',
    );
    if (fs.existsSync(sourceConfig))
      fs.copyFileSync(
        sourceConfig,
        path.join(directory, 'config', 'localizer.env'),
        fs.constants.COPYFILE_EXCL,
      );
    fs.writeFileSync(
      path.join(directory, 'config', 'markers.json'),
      `${JSON.stringify(
        routeMarkers ||
          (kidnapStartMarker && kidnapTargetMarker
            ? [kidnapStartMarker, kidnapTargetMarker]
            : referenceMarker
              ? [referenceMarker]
              : []),
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    if (runType === 'dynamic_occluded')
      fs.writeFileSync(
        path.join(directory, 'config', 'dynamic_occlusion.json'),
        `${JSON.stringify(
          {
            schema: 'luckfox.dynamic_occlusion.config.v1',
            source:
              routeReferenceId && routeReferenceName
                ? `Global route reference: ${routeReferenceName} (${routeReferenceId})`
                : 'Session route markers',
            markers: dynamicOcclusionMarkers,
            obstacle: {
              shape: 'upright_rectangular_prism',
              width_cm: 13,
              depth_cm: 13,
              height_cm: 30,
              distance_from_lidar_cm: 50,
              movement: 'left_to_right',
              duration_target_ms: 4_000,
              duration_tolerance_ms: 500,
            },
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      );
    const mapFile = this.ActiveMapFile();
    fs.writeFileSync(
      path.join(directory, 'config', 'map.json'),
      `${JSON.stringify(
        {
          name: path.basename(mapFile, '.bin'),
          path: mapFile,
          bytes: fs.statSync(mapFile).size,
          sha256: FileSha256(mapFile),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    this.Notify(session);
    return session;
  }

  async Preflight(): Promise<unknown> {
    const mapFile = this.ActiveMapFile();
    const stagedBinary = path.join(
      this.RepoRoot,
      'RV1106_BUILDROOT/luckfox-pico/sysdrv/source/buildroot/buildroot-2023.02.6/output/target/usr/bin/localize_uart',
    );
    const mapperScript = path.join(this.RepoRoot, 'MAPPER', 'Config', 'mapper');
    const mapper = await ExecFileAsync(mapperScript, ['status'], {
      cwd: this.RepoRoot,
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    }).catch((error: Error) => ({ stdout: '', stderr: error.message }));
    const remote = await this.RunSsh(
      "date -Iseconds 2>/dev/null || date; printf 'BINARY '; wc -c /usr/bin/localize_uart; sha256sum /usr/bin/localize_uart; printf 'MAP '; wc -c /etc/slam/ruang_utama.bin; sha256sum /etc/slam/ruang_utama.bin; cat /proc/net/wireless 2>/dev/null || true",
      12_000,
    ).catch((error: Error) => `ERROR ${error.message}`);
    const backendUnixMs = Date.now();
    const localMapSha256 = FileSha256(mapFile);
    const localBinarySha256 = fs.existsSync(stagedBinary) ? FileSha256(stagedBinary) : undefined;
    const boardBinarySha256 = remote.match(/BINARY[^\n]*\n([a-f0-9]{64})/i)?.[1];
    const boardMapSha256 = remote.match(/MAP[^\n]*\n([a-f0-9]{64})/i)?.[1];
    const boardTimestamp = Date.parse(remote.split('\n', 1)[0] || '');
    return {
      board_target: this.BoardSshTarget,
      active_map: path.basename(mapFile, '.bin'),
      backend_unix_ms: backendUnixMs,
      local_map_bytes: fs.statSync(mapFile).size,
      local_map_sha256: localMapSha256,
      board_map_sha256: boardMapSha256,
      local_binary_sha256: localBinarySha256,
      board_binary_sha256: boardBinarySha256,
      map_match: Boolean(boardMapSha256 && boardMapSha256 === localMapSha256),
      binary_match: Boolean(
        boardBinarySha256 && localBinarySha256 && boardBinarySha256 === localBinarySha256,
      ),
      board_clock_offset_ms: Number.isFinite(boardTimestamp)
        ? boardTimestamp - backendUnixMs
        : undefined,
      git_commit: this.GitValue(['rev-parse', 'HEAD']),
      git_dirty: Boolean(this.GitValue(['status', '--porcelain'])),
      mapper_status: `${mapper.stdout}${mapper.stderr}`.trim(),
      board_report: remote.trim(),
      active_experiment_id: this.ActiveExperimentId,
    };
  }

  async Start(experimentId: string): Promise<ExperimentSession> {
    const session = this.Get(experimentId);
    this.RequireState(session, ['created', 'error']);
    if (session.run_type === 'ablation')
      throw new Error('Use ablation replay instead of board capture for this session');
    if (this.ActiveExperimentId && this.ActiveExperimentId !== experimentId)
      throw new Error('Another experiment is still active');
    const rawScanCaptureEnabled = session.raw_scan_capture_enabled ?? session.run_type === 'route';
    const rawScanCaptureTarget = session.raw_scan_capture_target ?? 'backend';
    const backendRawScanCapture = rawScanCaptureEnabled && rawScanCaptureTarget === 'backend';
    const requiredBoardTmpKb =
      rawScanCaptureEnabled && rawScanCaptureTarget === 'board' ? 80 * 1024 : 8 * 1024;
    session.board_tmp_available_kb_before_start = await this.CleanBoardStorage();
    if (session.board_tmp_available_kb_before_start < requiredBoardTmpKb)
      throw new Error(
        `Board /tmp has only ${session.board_tmp_available_kb_before_start} KiB available after cleanup; ${requiredBoardTmpKb} KiB is required`,
      );
    session.state = 'starting';
    session.error = undefined;
    session.raw_scan_capture_target = rawScanCaptureEnabled ? rawScanCaptureTarget : undefined;
    session.raw_scan_streamed_frames = backendRawScanCapture ? 0 : undefined;
    session.raw_scan_streamed_points = backendRawScanCapture ? 0 : undefined;
    this.ActiveExperimentId = experimentId;
    this.PreviousRawScanSequence = undefined;
    this.RawScanStreamedFrames = 0;
    this.RawScanStreamedPoints = 0;
    if (backendRawScanCapture)
      fs.writeFileSync(
        path.join(this.Directory(experimentId), 'raw', 'raw_scans.csv'),
        'scan_sequence,timestamp_ns,angle_rad,range_m,intensity\n',
      );
    this.WriteSession(session);
    const remoteDir = this.RemoteDirectory(experimentId);
    const rawScanLog =
      rawScanCaptureEnabled && rawScanCaptureTarget === 'board' ? `${remoteDir}/raw_scans.csv` : '';
    const command = `set -eu
for stale in /tmp/luckfox_experiments/*; do
  test -d "$stale" || continue
  if test -f "$stale/pid" && kill -0 "$(cat "$stale/pid")" 2>/dev/null; then
    continue
  fi
  rm -rf "$stale"
done
test ! -e '${remoteDir}'
mkdir -p '${remoteDir}'
/etc/init.d/S99zzlocalize_uart stop
cp /etc/default/localize_uart '${remoteDir}/runtime_default.env'
touch '${remoteDir}/raw_scans.csv'
{
  date -Iseconds 2>/dev/null || date
  uname -a
  printf 'localize_uart_bytes='; wc -c < /usr/bin/localize_uart
  sha256sum /usr/bin/localize_uart
  printf 'map_bytes='; wc -c < /etc/slam/ruang_utama.bin
  sha256sum /etc/slam/ruang_utama.bin
  ip addr show wlan0
  ip route
  cat /proc/net/wireless 2>/dev/null || true
} > '${remoteDir}/system.txt'
set -a
. /etc/default/localize_uart
set +a
export LUCKFOX_EXPERIMENT_ID='${experimentId}'
export LUCKFOX_EXPERIMENT_CONDITION='${session.condition}'
export LUCKFOX_EXPERIMENT_RUN_TYPE='${session.run_type}'
export LUCKFOX_EXPERIMENT_ROUTE_ID='${session.route_id}'
export LUCKFOX_TELEMETRY_LOG='${remoteDir}/telemetry.jsonl'
export LUCKFOX_RAW_SCAN_LOG='${rawScanLog}'
nohup /usr/bin/localize_uart "$MAP" "$UART" "$BAUD" >'${remoteDir}/runtime.log' 2>&1 &
echo $! > '${remoteDir}/pid'
sleep 1
kill -0 "$(cat '${remoteDir}/pid')"
`;
    try {
      await this.RunSsh(command, 20_000);
      session.state = 'capturing';
      session.started_unix_ms = Date.now();
      this.PreviousSequence = undefined;
      this.WriteSession(session);
      return session;
    } catch (error) {
      session.state = 'error';
      session.error = (error as Error).message;
      this.WriteSession(session);
      await this.RunSsh(
        `if test -f '${remoteDir}/pid'; then kill $(cat '${remoteDir}/pid') 2>/dev/null || true; fi
rm -rf '${remoteDir}'
/etc/init.d/S99zzlocalize_uart start`,
        10_000,
      ).catch(() => undefined);
      this.ActiveExperimentId = undefined;
      throw error;
    }
  }

  async Stop(experimentId: string): Promise<ExperimentSession> {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing', 'error']);
    if (session.resource_active_phase)
      throw new Error(
        `End the active ${session.resource_active_phase} Resource interval before stopping capture`,
      );
    session.state = 'stopping';
    this.WriteSession(session);
    const remoteDir = this.RemoteDirectory(experimentId);
    try {
      await this.RunSsh(
        `set -eu
if test -f '${remoteDir}/pid'; then
  capture_pid="$(cat '${remoteDir}/pid')"
  kill "$capture_pid" 2>/dev/null || true
  for second in 1 2 3 4 5 6 7 8 9 10; do
    test -e "/proc/$capture_pid/stat" || break
    capture_state="$(awk '{ print $3 }' "/proc/$capture_pid/stat" 2>/dev/null || true)"
    test "$capture_state" = "Z" && break
    sleep 1
  done
  if test -e "/proc/$capture_pid/stat"; then
    capture_state="$(awk '{ print $3 }' "/proc/$capture_pid/stat" 2>/dev/null || true)"
    test "$capture_state" = "Z" || kill -9 "$capture_pid" 2>/dev/null || true
  fi
fi
sync`,
        15_000,
      );
      const raw = path.join(this.Directory(experimentId), 'raw');
      const backendRawScanCapture =
        session.raw_scan_capture_enabled && session.raw_scan_capture_target === 'backend';
      const boardCaptureFiles = [
        'telemetry.jsonl',
        ...(backendRawScanCapture ? [] : ['raw_scans.csv']),
        'runtime.log',
        'system.txt',
        'runtime_default.env',
      ];
      const captureFiles = [
        'telemetry.jsonl',
        'raw_scans.csv',
        'runtime.log',
        'system.txt',
        'runtime_default.env',
      ];
      const remoteManifest = await this.RunSsh(
        `set -eu
cd '${remoteDir}'
for name in ${boardCaptureFiles.map((name) => `'${name}'`).join(' ')}; do
  test -f "$name"
  sha256sum "$name"
done`,
        10_000,
      );
      const checksums = new Map(
        remoteManifest
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const match = line.match(/^([a-f0-9]{64})\s+\*?([A-Za-z0-9_.-]+)$/i);
            if (!match) throw new Error(`Invalid board capture manifest row: ${line}`);
            return [match[2]!, match[1]!.toLowerCase()] as const;
          }),
      );
      if (
        checksums.size !== boardCaptureFiles.length ||
        boardCaptureFiles.some((name) => !checksums.has(name))
      )
        throw new Error('Board capture manifest is incomplete');
      for (const name of boardCaptureFiles)
        await this.CopyRemoteVerified(
          `${remoteDir}/${name}`,
          path.join(raw, name),
          checksums.get(name)!,
        );
      if (backendRawScanCapture) {
        const localRawScan = path.join(raw, 'raw_scans.csv');
        if (!fs.existsSync(localRawScan) || fs.statSync(localRawScan).size === 0)
          throw new Error('Backend raw scan stream was not initialized');
        checksums.set('raw_scans.csv', FileSha256(localRawScan));
        session.raw_scan_streamed_frames = this.RawScanStreamedFrames;
        session.raw_scan_streamed_points = this.RawScanStreamedPoints;
      }
      const localManifest = `${captureFiles
        .map((name) => `${checksums.get(name)}  ${name}`)
        .join('\n')}\n`;
      const localManifestFile = path.join(raw, 'capture_manifest.sha256');
      if (fs.existsSync(localManifestFile)) {
        if (fs.readFileSync(localManifestFile, 'utf8') !== localManifest)
          throw new Error('Existing local capture manifest does not match the board');
      } else {
        fs.writeFileSync(localManifestFile, localManifest, { flag: 'wx' });
      }
      await this.RunSsh('/etc/init.d/S99zzlocalize_uart start', 10_000);
      await this.RunSsh(`rm -rf '${remoteDir}'`, 10_000);
      session.board_tmp_available_kb_after_stop = await this.CleanBoardStorage();
      session.state = 'stopped';
      session.error = undefined;
      session.stopped_unix_ms = Date.now();
      this.ActiveExperimentId = undefined;
      this.PreviousSequence = undefined;
      this.PreviousRawScanSequence = undefined;
      this.WriteSession(session);
      return session;
    } catch (error) {
      session.state = 'error';
      session.error = (error as Error).message;
      this.WriteSession(session);
      throw error;
    }
  }

  async Cancel(experimentId: string): Promise<{ experiment_id: string; deleted: true }> {
    const session = this.Get(experimentId);
    const resourceReplay = session.run_type === 'resource' && session.resource_mode === 'replay';
    if (session.state === 'starting' && (session.run_type === 'ablation' || resourceReplay)) {
      this.AblationCancellations.add(experimentId);
      this.AblationAbortControllers.get(experimentId)?.abort();
      const target = session.ablation_execution_target || 'host';
      if (target !== 'host') {
        const boardTarget = this.AblationBoardTargets[target];
        const remoteDirectory = `/tmp/${resourceReplay ? 'luckfox_resource_replay' : 'luckfox_ablation'}/${experimentId}`;
        await this.RunSshTarget(
          boardTarget,
          `set -eu
for pid_file in '${remoteDirectory}'/*.pid; do
  test -f "$pid_file" || continue
  replay_wrapper_pid="$(cat "$pid_file")"
  for replay_child_pid in $(ps -o pid,ppid | awk -v parent="$replay_wrapper_pid" 'NR > 1 && $2 == parent { print $1 }'); do
    kill "$replay_child_pid" 2>/dev/null || true
  done
  kill "$replay_wrapper_pid" 2>/dev/null || true
done
rm -rf '${remoteDirectory}'
/etc/init.d/S99zzlocalize_uart start`,
          15_000,
        ).catch(() => undefined);
      }
      for (let attempt = 0; attempt < 100 && this.ActiveExperimentId === experimentId; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.ActiveExperimentId === experimentId)
        throw new Error('Replay cancellation did not stop within 10 seconds');
    } else {
      this.RequireState(session, ['created', 'capturing', 'stopped', 'analyzed', 'error']);
    }
    const directory = this.Directory(experimentId);
    const timer = this.DynamicOcclusionTimers.get(experimentId);
    if (timer) clearTimeout(timer);
    this.DynamicOcclusionTimers.delete(experimentId);

    if (
      session.run_type !== 'ablation' &&
      !resourceReplay &&
      session.started_unix_ms !== undefined
    ) {
      const remoteDir = this.RemoteDirectory(experimentId);
      await this.RunSsh(
        `set -eu
if test -f '${remoteDir}/pid'; then
  capture_pid="$(cat '${remoteDir}/pid')"
  kill "$capture_pid" 2>/dev/null || true
  for second in 1 2 3 4 5; do
    test -e "/proc/$capture_pid/stat" || break
    capture_state="$(awk '{ print $3 }' "/proc/$capture_pid/stat" 2>/dev/null || true)"
    test "$capture_state" = "Z" && break
    sleep 1
  done
  if test -e "/proc/$capture_pid/stat"; then
    capture_state="$(awk '{ print $3 }' "/proc/$capture_pid/stat" 2>/dev/null || true)"
    test "$capture_state" = "Z" || kill -9 "$capture_pid" 2>/dev/null || true
  fi
fi
/etc/init.d/S99zzlocalize_uart start
rm -rf '${remoteDir}'
sync`,
        15_000,
      );
    }

    if (this.ActiveExperimentId === experimentId) this.ActiveExperimentId = undefined;
    this.PreviousSequence = undefined;
    this.PreviousRawScanSequence = undefined;
    this.RawScanStreamedFrames = 0;
    this.RawScanStreamedPoints = 0;
    fs.rmSync(directory, { recursive: true });
    return { experiment_id: experimentId, deleted: true };
  }

  RecordStreamedRawScan(sequence: number, payload: Buffer): void {
    if (!this.ActiveExperimentId) return;
    const session = this.Get(this.ActiveExperimentId);
    if (
      !['starting', 'capturing', 'stopping'].includes(session.state) ||
      !session.raw_scan_capture_enabled ||
      session.raw_scan_capture_target !== 'backend' ||
      this.PreviousRawScanSequence === sequence
    )
      return;
    const metadataBytes = 40;
    if (payload.length < metadataBytes) return;
    const timestampNs = payload.readBigUInt64BE(0);
    const pointCount = payload.readUInt32BE(36);
    if (pointCount > 10_000 || payload.length !== metadataBytes + pointCount * 12) return;
    const rows = new Array<string>(pointCount);
    const format = (value: number) =>
      Number.isFinite(value)
        ? value.toPrecision(9)
        : Number.isNaN(value)
          ? 'nan'
          : value > 0
            ? 'inf'
            : '-inf';
    for (let index = 0; index < pointCount; index++) {
      const offset = metadataBytes + index * 12;
      rows[index] = `${sequence},${timestampNs},${format(payload.readFloatBE(offset))},${format(
        payload.readFloatBE(offset + 4),
      )},${format(payload.readFloatBE(offset + 8))}`;
    }
    if (rows.length)
      fs.appendFileSync(
        path.join(this.Directory(session.experiment_id), 'raw', 'raw_scans.csv'),
        `${rows.join('\n')}\n`,
      );
    this.PreviousRawScanSequence = sequence;
    this.RawScanStreamedFrames++;
    this.RawScanStreamedPoints += pointCount;
  }

  async RunAblation(experimentId: string): Promise<ExperimentSession> {
    const session = this.Get(experimentId);
    this.RequireState(session, ['created', 'error']);
    const resourceReplay = session.run_type === 'resource' && session.resource_mode === 'replay';
    if ((session.run_type !== 'ablation' && !resourceReplay) || !session.source_experiment_id)
      throw new Error('This session is not configured for deterministic replay');
    if (this.ActiveExperimentId && this.ActiveExperimentId !== experimentId)
      throw new Error('Another experiment is still active');
    const eligibleSources = resourceReplay
      ? this.ListResourceReplaySources()
      : this.ListAblationSources();
    if (!eligibleSources.some((source) => source.experiment_id === session.source_experiment_id))
      throw new Error('The selected Accepted source is no longer replay-ready');
    const sourceDirectory = this.ResolveAblationSourceDirectory(session.source_experiment_id);
    const rawScan = path.join(sourceDirectory, 'raw', 'raw_scans.csv');
    const replayBinary = path.join(this.RepoRoot, 'LUCKFOX_LOCALIZER', 'build', 'localize_replay');
    if (!fs.existsSync(replayBinary)) throw new Error('localize_replay has not been built');
    const executionTarget = resourceReplay ? 'rv1103' : session.ablation_execution_target || 'host';
    const targetStatus = (await this.ListAblationTargets()).find(
      (target) => target.target === executionTarget,
    );
    if (!targetStatus?.ready)
      throw new Error(
        `${executionTarget.toUpperCase()} replay target is not ready: ${
          targetStatus?.reason || 'target unavailable'
        }`,
      );
    const boardTarget =
      executionTarget === 'host' ? undefined : this.AblationBoardTargets[executionTarget];
    const sourceSession = JSON.parse(
      fs.readFileSync(path.join(sourceDirectory, 'config', 'session.json'), 'utf8'),
    ) as ExperimentSession;
    if (sourceSession.state !== 'finalized')
      throw new Error('The ablation source recording must be finalized');
    const sourceMap = JSON.parse(
      fs.readFileSync(path.join(sourceDirectory, 'config', 'map.json'), 'utf8'),
    ) as { name?: string; path?: string; sha256?: string };
    const mapFile = path.resolve(String(sourceMap.path || ''));
    if (!mapFile.startsWith(`${this.RepoRoot}${path.sep}`) || !fs.existsSync(mapFile))
      throw new Error('The source map binary is unavailable inside the repository');
    const sourceMapSha256 = FileSha256(mapFile);
    if (sourceMapSha256 !== sourceMap.sha256)
      throw new Error('The source map hash no longer matches its capture metadata');
    const telemetryFile = path.join(sourceDirectory, 'raw', 'telemetry.jsonl');
    const sourceTelemetry = fs
      .readFileSync(telemetryFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sourceParameters = sourceTelemetry.find(
      (row) => row.schema === 'luckfox.localization.config.v1',
    );
    const initialTelemetry = sourceTelemetry.find(
      (row) => row.schema === 'luckfox.localization.scan.v1' && row.accepted === true,
    );
    if (!sourceParameters) throw new Error('The source localization parameter snapshot is missing');
    if (!initialTelemetry)
      throw new Error('The source has no accepted pose that can initialize deterministic replay');
    const initialPose = {
      x: Number(initialTelemetry.x_m),
      y: Number(initialTelemetry.y_m),
      yaw: Number(initialTelemetry.yaw_rad),
    };
    if (!Object.values(initialPose).every(Number.isFinite))
      throw new Error('The source initial replay pose is invalid');
    const sourceRawScanSha256 = FileSha256(rawScan);
    const replayEnvironment = { ...process.env };
    for (const [environmentName, parameterName] of Object.entries(ReplayEnvironmentNames)) {
      const value = Number(sourceParameters[parameterName]);
      if (!Number.isFinite(value))
        throw new Error(`The source parameter ${parameterName} is missing or invalid`);
      replayEnvironment[environmentName] = String(value);
    }
    replayEnvironment.LUCKFOX_EXECUTION_TARGET = executionTarget;
    replayEnvironment.LUCKFOX_REPLAY_PACING = resourceReplay ? 'recorded' : 'unpaced';
    const variants =
      executionTarget === 'host' ? [...FactorialReplayVariants] : [SelectedProductionReplayVariant];
    session.state = 'starting';
    session.started_unix_ms = Date.now();
    session.error = undefined;
    session.ablation_execution_target = executionTarget;
    session.ablation_completed_variants = [];
    this.ActiveExperimentId = experimentId;
    const ablationAbortController = new AbortController();
    this.AblationAbortControllers.set(experimentId, ablationAbortController);
    this.WriteSession(session);
    const remoteDirectory = boardTarget
      ? `/tmp/${resourceReplay ? 'luckfox_resource_replay' : 'luckfox_ablation'}/${session.experiment_id}`
      : undefined;
    const remoteMap = remoteDirectory ? `${remoteDirectory}/map.bin` : undefined;
    let boardPrepared = false;
    try {
      const targetDirectory = this.Directory(experimentId);
      const sourceConfigFile = path.join(targetDirectory, 'config', 'ablation_source.json');
      for (const file of [
        sourceConfigFile,
        ...variants.map((variant) => path.join(targetDirectory, 'raw', `replay_${variant}.jsonl`)),
      ])
        if (fs.existsSync(file)) fs.unlinkSync(file);
      if (boardTarget && remoteDirectory && remoteMap) {
        await this.RunSshTarget(
          boardTarget,
          `set -eu
/etc/init.d/S99zzlocalize_uart stop
rm -rf '${remoteDirectory}'
mkdir -p '${remoteDirectory}'`,
          15_000,
        );
        boardPrepared = true;
        await this.StreamFileToSsh(
          boardTarget,
          `dd of='${remoteMap}' bs=65536 conv=fsync 2>/dev/null`,
          mapFile,
          undefined,
          15_000,
        );
        const remoteMapHash = (
          await this.RunSshTarget(
            boardTarget,
            `sha256sum '${remoteMap}' | awk '{ print $1 }'`,
            10_000,
          )
        ).trim();
        if (remoteMapHash !== sourceMapSha256)
          throw new Error('Board replay map checksum does not match the Accepted source');
      }
      fs.writeFileSync(
        sourceConfigFile,
        `${JSON.stringify(
          {
            source_experiment_id: session.source_experiment_id,
            source_run_type: sourceSession.run_type,
            source_condition: sourceSession.condition,
            source_route_id: sourceSession.route_id,
            source_raw_scan: rawScan,
            source_raw_scan_sha256: sourceRawScanSha256,
            source_map: mapFile,
            source_map_name: sourceMap.name,
            source_map_sha256: sourceMapSha256,
            source_parameters: Object.fromEntries(
              Object.entries(ReplayEnvironmentNames).map(([environmentName, parameterName]) => [
                parameterName,
                Number(replayEnvironment[environmentName]),
              ]),
            ),
            initial_pose: initialPose,
            execution_target: executionTarget,
            execution_host: boardTarget || os.hostname(),
            replay_binary_sha256: targetStatus.replay_binary_sha256 || FileSha256(replayBinary),
            validation_mode: resourceReplay
              ? 'resource_replay_board'
              : executionTarget === 'host'
                ? 'factorial_ablation'
                : 'selected_method_board',
            replay_pacing: resourceReplay ? 'recorded' : 'unpaced',
            variants,
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      );
      let replayScanCount: number | undefined;
      for (const variant of variants) {
        const replayOutput = path.join(targetDirectory, 'raw', `replay_${variant}.jsonl`);
        let output: string;
        if (boardTarget && remoteMap && remoteDirectory) {
          const replayPort = 42110;
          const boardHost = boardTarget.includes('@')
            ? boardTarget.slice(boardTarget.lastIndexOf('@') + 1)
            : boardTarget;
          const remoteEnvironment = [
            ...Object.keys(ReplayEnvironmentNames),
            'LUCKFOX_EXECUTION_TARGET',
            'LUCKFOX_REPLAY_PACING',
          ]
            .map((name) => `${name}='${String(replayEnvironment[name])}'`)
            .join(' ');
          const remoteStatus = `${remoteDirectory}/${variant}.status`;
          const remoteLog = `${remoteDirectory}/${variant}.log`;
          const remotePid = `${remoteDirectory}/${variant}.pid`;
          await this.RunSshTarget(
            boardTarget,
            `set -eu
rm -f '${remoteStatus}' '${remoteLog}' '${remotePid}'
nohup sh -c "${remoteEnvironment} /usr/bin/localize_replay '${remoteMap}' 'tcp-listen:${replayPort}' --mode '${variant}' --initial '${initialPose.x}' '${initialPose.y}' '${initialPose.yaw}'; replay_status=\\$?; printf '%s\\n' \\"\\$replay_status\\" > '${remoteStatus}'; exit \\"\\$replay_status\\"" </dev/null >/dev/null 2>'${remoteLog}' &
printf '%s\\n' "$!" > '${remotePid}'`,
            10_000,
          );
          try {
            await this.StreamFileToTcp(
              boardHost,
              replayPort,
              rawScan,
              replayOutput,
              30 * 60_000,
              ablationAbortController.signal,
            );
          } catch (error) {
            const boardLog = await this.RunSshTarget(
              boardTarget,
              `cat '${remoteLog}' 2>/dev/null || true`,
              10_000,
            ).catch(() => '');
            throw new Error(
              `${(error as Error).message}${boardLog.trim() ? `: ${boardLog.trim()}` : ''}`,
            );
          }
          const replayStatus = (
            await this.RunSshTarget(
              boardTarget,
              `for attempt in 1 2 3 4 5 6 7 8 9 10; do
  test -f '${remoteStatus}' && break
  sleep 1
done
test -f '${remoteStatus}'
cat '${remoteStatus}'
cat '${remoteLog}' >&2`,
              15_000,
            )
          ).trim();
          if (replayStatus !== '0')
            throw new Error(`${variant} board replay exited ${replayStatus || 'without status'}`);
          output = fs.readFileSync(replayOutput, 'utf8');
        } else {
          const result = await ExecFileAsync(
            replayBinary,
            [
              mapFile,
              rawScan,
              '--mode',
              variant,
              '--initial',
              String(initialPose.x),
              String(initialPose.y),
              String(initialPose.yaw),
            ],
            {
              cwd: this.RepoRoot,
              env: replayEnvironment,
              timeout: 30 * 60_000,
              maxBuffer: 256 * 1024 * 1024,
              signal: ablationAbortController.signal,
            },
          );
          output = result.stdout;
          fs.writeFileSync(replayOutput, output, { flag: 'wx' });
        }
        const scanCount = (output.match(/\n/g) || []).length;
        if (!scanCount) throw new Error(`Replay output is empty for ${variant}`);
        if (replayScanCount !== undefined && replayScanCount !== scanCount)
          throw new Error(
            `Replay scan count mismatch: expected ${replayScanCount}, found ${scanCount} for ${variant}`,
          );
        replayScanCount = scanCount;
        const firstReplay = JSON.parse(output.split(/\r?\n/, 1)[0]!) as {
          execution_target?: string;
          replay_pacing?: string;
        };
        if (firstReplay.execution_target !== executionTarget)
          throw new Error(
            `${variant} reported execution target ${firstReplay.execution_target || '(missing)'}`,
          );
        if (resourceReplay && firstReplay.replay_pacing !== session.resource_replay_pacing)
          throw new Error(
            `${variant} reported replay pacing ${firstReplay.replay_pacing || '(missing)'}`,
          );
        session.ablation_completed_variants = [
          ...(session.ablation_completed_variants || []),
          variant,
        ];
        this.WriteSession(session);
      }
      if (FileSha256(rawScan) !== sourceRawScanSha256)
        throw new Error('The source raw scan changed while ablation replay was running');
      if (FileSha256(mapFile) !== sourceMapSha256)
        throw new Error('The source map changed while ablation replay was running');
      if (boardTarget && remoteDirectory) {
        await this.RunSshTarget(
          boardTarget,
          `rm -rf '${remoteDirectory}'
/etc/init.d/S99zzlocalize_uart start`,
          15_000,
        );
        boardPrepared = false;
      }
      session.state = 'stopped';
      session.stopped_unix_ms = Date.now();
      this.ActiveExperimentId = undefined;
      this.AblationAbortControllers.delete(experimentId);
      this.AblationCancellations.delete(experimentId);
      this.WriteSession(session);
      return session;
    } catch (error) {
      if (boardPrepared && boardTarget && remoteDirectory)
        await this.RunSshTarget(
          boardTarget,
          `for pid_file in '${remoteDirectory}'/*.pid; do
  test -f "$pid_file" || continue
  replay_wrapper_pid="$(cat "$pid_file")"
  for replay_child_pid in $(ps -o pid,ppid | awk -v parent="$replay_wrapper_pid" 'NR > 1 && $2 == parent { print $1 }'); do
    kill "$replay_child_pid" 2>/dev/null || true
  done
  kill "$replay_wrapper_pid" 2>/dev/null || true
done
rm -rf '${remoteDirectory}'
/etc/init.d/S99zzlocalize_uart start`,
          15_000,
        ).catch(() => undefined);
      const cancelled = this.AblationCancellations.delete(experimentId);
      this.ActiveExperimentId = undefined;
      this.AblationAbortControllers.delete(experimentId);
      if (!cancelled) {
        session.state = 'error';
        session.error = (error as Error).message;
        this.WriteSession(session);
      }
      throw new Error(cancelled ? 'Ablation replay was cancelled' : (error as Error).message);
    }
  }

  RecordStatus(status: ExperimentRobotStatus): void {
    const session = this.GetActive();
    if (!session || (session.state !== 'starting' && session.state !== 'capturing')) return;
    const directory = this.Directory(session.experiment_id);
    AppendJsonLine(path.join(directory, 'raw', 'backend_status.jsonl'), {
      schema: 'luckfox.experiment.backend_status.v1',
      robot_id: status.robot_id,
      seq: status.seq,
      timestamp_ms: status.timestamp_ms,
      pose: status.pose,
      mission_running: status.mission_running,
      online: status.online,
      received_ms: status.received_ms,
    });
    AppendJsonLine(path.join(directory, 'raw', 'backend_arrival.jsonl'), {
      schema: 'luckfox.backend.arrival.v1',
      robot_id: status.robot_id,
      sequence: status.seq,
      robot_timestamp_ms: status.timestamp_ms,
      backend_received_unix_ms: status.received_ms,
      sequence_gap:
        this.PreviousSequence !== undefined && status.seq > this.PreviousSequence + 1
          ? status.seq - this.PreviousSequence - 1
          : 0,
    });
    this.PreviousSequence = status.seq;
    session.status_count++;
    if (
      session.run_type === 'kidnapped' &&
      session.state === 'capturing' &&
      session.kidnap_release_unix_ms &&
      !session.kidnap_auto_checkpoint_unix_ms &&
      (session.checkpoint_count || 0) === 0
    ) {
      if (
        !session.kidnap_recovery_observed &&
        (!status.pose.valid || status.pose.mode === 'global')
      ) {
        session.kidnap_recovery_observed = true;
        this.WriteSession(session);
      } else if (
        session.kidnap_recovery_observed &&
        status.pose.valid &&
        status.pose.mode === 'tracking'
      ) {
        const marker = session.kidnap_target_marker;
        if (!marker) throw new Error('Kidnap target marker B is not configured');
        const updated = this.RecordCheckpoint(
          session.experiment_id,
          {
            marker_id: marker.marker_id,
            notes: 'Automatically recorded after recovery returned to TRACKING',
          },
          status,
        );
        updated.kidnap_auto_checkpoint_unix_ms = Date.now();
        AppendJsonLine(path.join(directory, 'raw', 'operator_events.jsonl'), {
          schema: 'luckfox.experiment.event.v1',
          timestamp_ms: updated.kidnap_auto_checkpoint_unix_ms,
          event: 'KIDNAP_AUTO_CHECKPOINT',
          source: 'backend',
          data: {
            marker_id: marker.marker_id,
            robot_sequence: status.seq,
          },
        });
        this.WriteSession(updated);
        this.Notify(updated);
        return;
      }
    }
    if (session.status_count % 10 === 0) this.WriteSession(session);
  }

  RecordSystemEvent(event: string, data: unknown = {}): void {
    const session = this.GetActive();
    if (!session || !Events.has(event)) return;
    AppendJsonLine(
      path.join(this.Directory(session.experiment_id), 'raw', 'operator_events.jsonl'),
      {
        schema: 'luckfox.experiment.event.v1',
        timestamp_ms: Date.now(),
        event,
        source: 'backend',
        data,
      },
    );
  }

  RecordEvent(
    experimentId: string,
    input: Record<string, unknown>,
    status?: ExperimentRobotStatus,
  ): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing']);
    const event = SafeText(input.event, 40).toUpperCase();
    if (!Events.has(event)) throw new Error('Invalid event');
    let reference = this.ParseReference(input);
    const data: Record<string, unknown> = {};
    if (event === 'KIDNAP_START' || event === 'KIDNAP_RELEASE') {
      if (session.run_type !== 'kidnapped')
        throw new Error('Kidnap events require a kidnapped session');
      const marker =
        event === 'KIDNAP_START' ? session.kidnap_start_marker : session.kidnap_target_marker;
      if (!marker) throw new Error(`The ${event} reference marker is not configured`);
      reference = { x: marker.x, y: marker.y, yaw: marker.yaw, marker_id: marker.marker_id };
    }
    if (event.startsWith('DYNAMIC_OCCLUSION_')) {
      const isDynamicSession =
        session.run_type === 'dynamic_occluded' ||
        (session.run_type === 'route' && session.condition === 'dynamic_occluded');
      if (!isDynamicSession || session.condition !== 'dynamic_occluded')
        throw new Error('Dynamic-occlusion events require a dynamic_occluded test session');
      const triggerMarker = SafeText(input.trigger_marker, 20).toUpperCase();
      const configuredMarkers = session.dynamic_occlusion_markers || [];
      const configuredMarker = configuredMarkers.find(
        (marker) => marker.marker_id === triggerMarker,
      );
      if (!configuredMarker)
        throw new Error(`Dynamic occlusion marker ${triggerMarker || '(empty)'} is not configured`);
      if (event === 'DYNAMIC_OCCLUSION_START') {
        if (!status || !status.online)
          throw new Error('Robot status is required to save the occlusion checkpoint');
        if (!status.pose.valid || status.pose.mode !== 'tracking')
          throw new Error('Robot must have a valid TRACKING pose before OCCLUSION START');
        const positionError = Math.hypot(
          status.pose.x - configuredMarker.x,
          status.pose.y - configuredMarker.y,
        );
        const headingError = HeadingErrorDegrees(status.pose.yaw, configuredMarker.yaw);
        if (positionError > 0.15)
          throw new Error(
            `Robot must be within 0.15 m of ${triggerMarker}; current error is ${positionError.toFixed(3)} m`,
          );
        if (headingError > 15)
          throw new Error(
            `Robot heading must be within 15° of ${triggerMarker}; current error is ${headingError.toFixed(1)}°`,
          );
        const checkpoints = this.Checkpoints(experimentId);
        const expectedCheckpoint = session.route_markers?.[checkpoints.length]?.marker_id;
        if (expectedCheckpoint !== triggerMarker)
          throw new Error(
            `Record checkpoint ${expectedCheckpoint || '(route complete)'} before starting occlusion at ${triggerMarker}`,
          );
      }
      data.trigger_marker = triggerMarker;
      data.occluder_direction = 'LEFT_TO_RIGHT';
      data.obstacle_width_cm = 13;
      data.obstacle_depth_cm = 13;
      data.obstacle_height_cm = 30;
      data.obstacle_distance_from_lidar_cm = 50;
    }
    if (event.startsWith('RESOURCE_')) {
      if (session.run_type !== 'resource')
        throw new Error('Resource events require a resource session');
      if (session.resource_mode === 'replay')
        throw new Error('Resource interval events require a LIVE Resource session');
      const enduranceMode = session.resource_mode === 'live_endurance';
      const enduranceEvent = event.startsWith('RESOURCE_ENDURANCE_');
      if (enduranceMode !== enduranceEvent)
        throw new Error(
          enduranceMode
            ? 'LIVE ENDURANCE accepts only the Endurance interval'
            : 'LIVE IDLE + TRACKING accepts only Idle, Tracking R1, and Tracking R2 intervals',
        );
      data.repetition = 1;
    }
    const eventsFile = path.join(this.Directory(experimentId), 'raw', 'operator_events.jsonl');
    const previousEvents = fs
      .readFileSync(eventsFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            event?: string;
            timestamp_ms?: number;
            data?: Record<string, unknown>;
          },
      );
    if (event === 'KIDNAP_START' || event === 'KIDNAP_RELEASE') {
      if (previousEvents.some((row) => row.event === event))
        throw new Error(`${event} has already been recorded`);
      if (event === 'KIDNAP_RELEASE' && !previousEvents.some((row) => row.event === 'KIDNAP_START'))
        throw new Error('Record KIDNAP_START before KIDNAP_RELEASE');
    }
    if (event === 'ROUTE_START' || event === 'ROUTE_END') {
      if (!['route', 'dynamic_occluded'].includes(session.run_type))
        throw new Error('Route events require a route-based test session');
      if (previousEvents.some((row) => row.event === event))
        throw new Error(`${event} has already been recorded`);
      const checkpointCount = this.Checkpoints(experimentId).length;
      if (event === 'ROUTE_START') {
        if (checkpointCount !== 0)
          throw new Error('Record ROUTE START before the first checkpoint');
        session.route_started = true;
      } else {
        if (!previousEvents.some((row) => row.event === 'ROUTE_START'))
          throw new Error('Record ROUTE START before ROUTE END');
        if (checkpointCount !== 8)
          throw new Error(`ROUTE END requires exactly 8 checkpoints; found ${checkpointCount}`);
        session.route_ended = true;
      }
    }
    if (event.startsWith('DYNAMIC_OCCLUSION_') || event.startsWith('RESOURCE_')) {
      const duplicate = previousEvents.some(
        (row) =>
          row.event === event &&
          (data.repetition !== undefined
            ? row.data?.repetition === data.repetition
            : row.data?.trigger_marker === data.trigger_marker),
      );
      if (duplicate)
        throw new Error(
          `${event} has already been recorded for ${String(data.trigger_marker || `repetition ${data.repetition}`)}`,
        );
      if (event.endsWith('_END')) {
        const startEvent = event.replace(/_END$/, '_START');
        const matchingStart = previousEvents.find(
          (row) =>
            row.event === startEvent &&
            (data.repetition !== undefined
              ? row.data?.repetition === data.repetition
              : row.data?.trigger_marker === data.trigger_marker),
        );
        if (!matchingStart) throw new Error(`Record ${startEvent} before ${event}`);
      }
    }
    const timestamp = Date.now();
    if (event.startsWith('RESOURCE_')) {
      const phase = event.replace(/_(START|END)$/, '');
      if (event.endsWith('_START')) {
        if (session.resource_active_phase)
          throw new Error(
            `End ${session.resource_active_phase} before starting another Resource interval`,
          );
        session.resource_active_phase = phase;
        session.resource_active_started_unix_ms = timestamp;
      } else {
        if (session.resource_active_phase !== phase)
          throw new Error(`The active Resource interval is ${session.resource_active_phase}`);
        session.resource_completed_phases = [...(session.resource_completed_phases || []), phase];
        session.resource_active_phase = undefined;
        session.resource_active_started_unix_ms = undefined;
      }
    }
    if (event.startsWith('DYNAMIC_OCCLUSION_')) {
      const markerId = String(data.trigger_marker);
      const completed = session.dynamic_occlusion_completed_marker_ids || [];
      const expected = session.dynamic_occlusion_markers?.[completed.length]?.marker_id;
      if (event === 'DYNAMIC_OCCLUSION_START') {
        if (session.dynamic_occlusion_active_marker_id)
          throw new Error(
            `Finish occlusion at ${session.dynamic_occlusion_active_marker_id} before starting another`,
          );
        if (markerId !== expected)
          throw new Error(`The next dynamic-occlusion marker is ${expected || '(none)'}`);
        session.dynamic_occlusion_active_marker_id = markerId;
        session.dynamic_occlusion_active_started_unix_ms = timestamp;
      } else {
        if (session.dynamic_occlusion_active_marker_id !== markerId)
          throw new Error(
            `Finish the active occlusion at ${session.dynamic_occlusion_active_marker_id}`,
          );
        const duration = timestamp - Number(session.dynamic_occlusion_active_started_unix_ms);
        session.dynamic_occlusion_completed_marker_ids = [...completed, markerId];
        session.dynamic_occlusion_durations_ms = {
          ...(session.dynamic_occlusion_durations_ms || {}),
          [markerId]: duration,
        };
        session.dynamic_occlusion_active_marker_id = undefined;
        session.dynamic_occlusion_active_started_unix_ms = undefined;
      }
    }
    if (event === 'KIDNAP_RELEASE') {
      session.kidnap_release_unix_ms = timestamp;
      session.kidnap_recovery_observed = false;
      session.kidnap_auto_checkpoint_unix_ms = undefined;
    }
    AppendJsonLine(eventsFile, {
      schema: 'luckfox.experiment.event.v1',
      timestamp_ms: timestamp,
      event,
      source: 'operator',
      reference,
      data,
      notes: SafeText(input.notes, 500),
    });
    this.WriteSession(session);
    this.Notify(session);
    if (event === 'DYNAMIC_OCCLUSION_START') this.ScheduleDynamicOcclusionEnd(session);
    if (event === 'DYNAMIC_OCCLUSION_END') {
      const timer = this.DynamicOcclusionTimers.get(experimentId);
      if (timer) clearTimeout(timer);
      this.DynamicOcclusionTimers.delete(experimentId);
    }
    if (event === 'DYNAMIC_OCCLUSION_START')
      return this.RecordCheckpoint(experimentId, { marker_id: data.trigger_marker }, status);
    return session;
  }

  private ScheduleDynamicOcclusionEnd(session: ExperimentSession): void {
    const markerId = session.dynamic_occlusion_active_marker_id;
    const startedAt = session.dynamic_occlusion_active_started_unix_ms;
    if (!markerId || !startedAt) return;
    const previousTimer = this.DynamicOcclusionTimers.get(session.experiment_id);
    if (previousTimer) clearTimeout(previousTimer);
    const delay = Math.max(0, startedAt + 4_000 - Date.now());
    const timer = setTimeout(() => {
      this.DynamicOcclusionTimers.delete(session.experiment_id);
      try {
        const current = this.Get(session.experiment_id);
        if (
          current.state === 'capturing' &&
          current.dynamic_occlusion_active_marker_id === markerId
        )
          this.RecordEvent(session.experiment_id, {
            event: 'DYNAMIC_OCCLUSION_END',
            trigger_marker: markerId,
          });
      } catch (error) {
        console.error(
          `Automatic OCCLUSION END failed for ${session.experiment_id}/${markerId}:`,
          error,
        );
      }
    }, delay);
    timer.unref();
    this.DynamicOcclusionTimers.set(session.experiment_id, timer);
  }

  RecordCheckpoint(
    experimentId: string,
    input: Record<string, unknown>,
    status: ExperimentRobotStatus | undefined,
  ): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing']);
    if (!status || !status.online) throw new Error('Robot status is unavailable');
    if (!status.pose.valid) throw new Error('A valid localization pose is required');
    if (session.run_type === 'dynamic_occluded' && status.pose.mode !== 'tracking')
      throw new Error('Dynamic-occlusion checkpoints require TRACKING mode');
    const requestedMarkerId = SafeText(input.marker_id, 40);
    const lockedMarker =
      session.run_type === 'ground_truth'
        ? session.reference_marker
        : session.run_type === 'kidnapped'
          ? session.kidnap_target_marker
          : session.route_markers?.find((marker) => marker.marker_id === requestedMarkerId);
    if (
      session.run_type === 'kidnapped' &&
      requestedMarkerId &&
      requestedMarkerId !== session.kidnap_target_marker?.marker_id
    )
      throw new Error('The kidnapped final checkpoint must use target marker B');
    if (
      ['route', 'dynamic_occluded'].includes(session.run_type) &&
      session.route_markers &&
      !lockedMarker
    )
      throw new Error(`Marker ${requestedMarkerId || '(empty)'} is not configured for this route`);
    const reference = lockedMarker
      ? {
          x: lockedMarker.x,
          y: lockedMarker.y,
          yaw: lockedMarker.yaw,
          marker_id: lockedMarker.marker_id,
        }
      : this.ParseReference(input);
    if (!reference) throw new Error('Reference pose is required');
    const markerId = lockedMarker?.marker_id || requestedMarkerId;
    if (!markerId) throw new Error('Marker ID is required');
    const checkpoints = this.Checkpoints(experimentId);
    const existingCheckpoint = checkpoints.find((row) => row.marker_id === markerId);
    if (
      ['route', 'dynamic_occluded'].includes(session.run_type) &&
      !existingCheckpoint &&
      session.route_markers?.[checkpoints.length]?.marker_id !== markerId
    )
      throw new Error(
        `The next route checkpoint is ${session.route_markers?.[checkpoints.length]?.marker_id || '(none)'}`,
      );
    if (
      session.run_type === 'dynamic_occluded' &&
      session.dynamic_occlusion_markers?.some((marker) => marker.marker_id === markerId) &&
      !session.dynamic_occlusion_completed_marker_ids?.includes(markerId) &&
      session.dynamic_occlusion_active_marker_id !== markerId
    )
      throw new Error(`Complete OCCLUSION START and END at ${markerId} before its checkpoint`);
    if (session.run_type === 'ground_truth' && checkpoints.length >= 10)
      throw new Error('Ground-truth verification already has 10 placements');
    if (session.run_type === 'kidnapped' && checkpoints.length >= 1)
      throw new Error('The kidnapped final checkpoint at marker B has already been recorded');
    if (['route', 'dynamic_occluded'].includes(session.run_type)) {
      if (checkpoints.length >= 8 && !existingCheckpoint)
        throw new Error('The route already has 8 checkpoints');
    }
    const checkpointFile = path.join(this.Directory(experimentId), 'raw', 'ground_truth.jsonl');
    const checkpoint = {
      schema: 'luckfox.experiment.checkpoint.v1',
      timestamp_ms: Date.now(),
      marker_id: markerId,
      zone: lockedMarker?.zone || SafeText(input.zone || session.zone, 32),
      reference,
      estimate: status.pose,
      robot_timestamp_ms: status.timestamp_ms,
      backend_received_ms: status.received_ms,
      robot_sequence: status.seq,
      notes: SafeText(input.notes, 500),
    };
    if (existingCheckpoint && ['route', 'dynamic_occluded'].includes(session.run_type)) {
      const rows = fs
        .readFileSync(checkpointFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const existingIndex = rows.findIndex((row) => row.marker_id === markerId);
      const previousCheckpoint = rows[existingIndex];
      rows[existingIndex] = checkpoint;
      fs.writeFileSync(checkpointFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      AppendJsonLine(path.join(this.Directory(experimentId), 'raw', 'operator_events.jsonl'), {
        schema: 'luckfox.experiment.event.v1',
        timestamp_ms: Date.now(),
        event: 'CHECKPOINT_REPLACED',
        source: 'operator',
        data: {
          marker_id: markerId,
          previous_checkpoint: previousCheckpoint,
          replacement_checkpoint: checkpoint,
        },
      });
      session.checkpoint_count = checkpoints.length;
    } else {
      AppendJsonLine(checkpointFile, checkpoint);
      session.checkpoint_count = checkpoints.length + 1;
      session.recorded_marker_ids = [...(session.recorded_marker_ids || []), markerId];
    }
    if (['route', 'dynamic_occluded'].includes(session.run_type))
      session.checkpoint_estimates = {
        ...(session.checkpoint_estimates || {}),
        [markerId]: status.pose,
      };
    if (['route', 'dynamic_occluded'].includes(session.run_type)) {
      session.route_started = (session.checkpoint_count || 0) >= 1;
      session.route_ended = session.checkpoint_count === 8;
    }
    this.WriteSession(session);
    this.Notify(session);
    return session;
  }

  UnlockCheckpoint(experimentId: string, markerIdInput: unknown): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing']);
    if (!['route', 'dynamic_occluded'].includes(session.run_type))
      throw new Error('Checkpoint unlock is only available for route-based tests');
    const markerId = SafeText(markerIdInput, 40);
    if (!markerId) throw new Error('Marker ID is required');

    const checkpointFile = path.join(this.Directory(experimentId), 'raw', 'ground_truth.jsonl');
    const rows = fs
      .readFileSync(checkpointFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const existingIndex = rows.findIndex((row) => row.marker_id === markerId);
    if (existingIndex < 0) throw new Error(`Marker ${markerId} is not locked`);
    if (existingIndex !== rows.length - 1)
      throw new Error('Only the most recently recorded checkpoint can be unlocked');
    const [removedCheckpoint] = rows.splice(existingIndex, 1);
    fs.writeFileSync(
      checkpointFile,
      rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    );
    AppendJsonLine(path.join(this.Directory(experimentId), 'raw', 'operator_events.jsonl'), {
      schema: 'luckfox.experiment.event.v1',
      timestamp_ms: Date.now(),
      event: 'CHECKPOINT_UNLOCKED',
      source: 'operator',
      data: {
        marker_id: markerId,
        removed_checkpoint: removedCheckpoint,
      },
    });
    session.checkpoint_count = rows.length;
    session.route_started = rows.length >= 1;
    session.route_ended = rows.length === 8;
    session.recorded_marker_ids = (session.recorded_marker_ids || []).filter(
      (recordedMarkerId) => recordedMarkerId !== markerId,
    );
    const estimates = { ...(session.checkpoint_estimates || {}) };
    delete estimates[markerId];
    session.checkpoint_estimates = estimates;
    this.WriteSession(session);
    this.Notify(session);
    return session;
  }

  Analyze(experimentId: string): { session: ExperimentSession; summary: unknown } {
    const session = this.Get(experimentId);
    this.RequireState(session, ['stopped']);
    const raw = path.join(this.Directory(experimentId), 'raw');
    const JsonLineCount = (name: string, event?: string): number => {
      const file = path.join(raw, name);
      if (!fs.existsSync(file)) return 0;
      return fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => {
          if (!line.trim()) return false;
          return !event || (JSON.parse(line) as { event?: string }).event === event;
        }).length;
    };
    const checkpointCount = JsonLineCount('ground_truth.jsonl');
    if (session.run_type === 'ground_truth' && checkpointCount !== 10)
      throw new Error(
        `Ground-truth verification requires exactly 10 placements; found ${checkpointCount}`,
      );
    if (['route', 'dynamic_occluded'].includes(session.run_type) && checkpointCount !== 8)
      throw new Error(
        `A route-based test requires exactly 8 marker checkpoints; found ${checkpointCount}`,
      );
    const eventFile = path.join(raw, 'operator_events.jsonl');
    const recordedEvents = fs.existsSync(eventFile)
      ? fs
          .readFileSync(eventFile, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                event?: string;
                timestamp_ms?: number;
                data?: Record<string, unknown>;
              },
          )
      : [];
    if (['route', 'dynamic_occluded'].includes(session.run_type)) {
      const checkpoints = this.Checkpoints(experimentId);
      if (new Set(checkpoints.map((row) => row.marker_id)).size !== 8)
        throw new Error('A route-based test requires 8 unique marker IDs');
      session.route_started = true;
      session.route_ended = true;
      session.checkpoint_count = 8;
      this.WriteSession(session);
    }
    if (
      session.run_type === 'dynamic_occluded' ||
      (session.run_type === 'route' && session.condition === 'dynamic_occluded')
    ) {
      const starts = recordedEvents.filter((row) => row.event === 'DYNAMIC_OCCLUSION_START');
      const ends = recordedEvents.filter((row) => row.event === 'DYNAMIC_OCCLUSION_END');
      const configuredMarkers = session.dynamic_occlusion_markers || [];
      if (starts.length !== 6 || ends.length !== 6)
        throw new Error(
          'A dynamic-occlusion trial requires one START and END at each marker M2 through M7',
        );
      for (const marker of configuredMarkers) {
        const start = starts.find((row) => row.data?.trigger_marker === marker.marker_id);
        const end = ends.find((row) => row.data?.trigger_marker === marker.marker_id);
        if (!start || !end)
          throw new Error(`Dynamic occlusion at ${marker.marker_id} is incomplete`);
        const duration = Number(end.timestamp_ms) - Number(start.timestamp_ms);
        if (duration < 3_500 || duration > 4_500)
          throw new Error(
            `${marker.marker_id} occlusion must take 4 ± 0.5 seconds; recorded ${(duration / 1000).toFixed(2)} seconds`,
          );
      }
    }
    if (session.run_type === 'kidnapped') {
      const starts = JsonLineCount('operator_events.jsonl', 'KIDNAP_START');
      const releases = JsonLineCount('operator_events.jsonl', 'KIDNAP_RELEASE');
      if (starts !== 1 || releases !== 1 || checkpointCount !== 1)
        throw new Error(
          'A kidnapped trial requires one start event, one release event, and one final checkpoint',
        );
    }
    if (session.run_type === 'resource' && session.resource_mode !== 'replay') {
      if (session.resource_mode === 'live_endurance') {
        const enduranceStart = recordedEvents.find(
          (row) => row.event === 'RESOURCE_ENDURANCE_START',
        );
        const enduranceEnd = recordedEvents.find((row) => row.event === 'RESOURCE_ENDURANCE_END');
        if (!enduranceStart || !enduranceEnd)
          throw new Error('LIVE ENDURANCE requires one complete START and END interval');
        if (Number(enduranceEnd.timestamp_ms) <= Number(enduranceStart.timestamp_ms))
          throw new Error('LIVE ENDURANCE end time must be after its start time');
      } else {
        for (const prefix of ['RESOURCE_IDLE', 'RESOURCE_TRACKING_R1', 'RESOURCE_TRACKING_R2']) {
          const starts = recordedEvents.filter((row) => row.event === `${prefix}_START`);
          const ends = recordedEvents.filter((row) => row.event === `${prefix}_END`);
          if (starts.length !== 1 || ends.length !== 1)
            throw new Error(`${prefix} requires one complete 60-second interval`);
          const duration = Number(ends[0]!.timestamp_ms) - Number(starts[0]!.timestamp_ms);
          if (duration < 55_000 || duration > 70_000)
            throw new Error(`${prefix} must be approximately 60 seconds (55–70 seconds)`);
        }
      }
    }
    const summary = AnalyzeExperiment(this.Directory(experimentId), experimentId, session.run_type);
    session.state = 'analyzed';
    session.analyzed_unix_ms = Date.now();
    this.WriteSession(session);
    return { session, summary };
  }

  Finalize(experimentId: string): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['analyzed']);
    if (
      session.run_type === 'ablation' ||
      (session.run_type === 'resource' && session.resource_mode === 'replay')
    ) {
      const summary = JSON.parse(
        fs.readFileSync(
          path.join(this.Directory(experimentId), 'processed', 'summary.json'),
          'utf8',
        ),
      ) as { protocol_valid?: boolean; validity_errors?: string[] };
      if (summary.protocol_valid !== true)
        throw new Error(
          `Replay protocol is invalid: ${
            summary.validity_errors?.join('; ') || 'unknown validation failure'
          }`,
        );
    }
    session.state = 'finalized';
    session.finalized_unix_ms = Date.now();
    this.WriteSession(session);
    const directory = this.Directory(experimentId);
    const inventoryFile = path.join(directory, 'inventory.json');
    const manifestFile = path.join(directory, 'manifest.sha256');
    if (fs.existsSync(inventoryFile) || fs.existsSync(manifestFile))
      throw new Error('Manifest or inventory already exists');
    const files = WalkFiles(directory)
      .filter((file) => file !== inventoryFile && file !== manifestFile)
      .sort();
    const inventory = files.map((file) => ({
      path: path.relative(directory, file),
      bytes: fs.statSync(file).size,
      sha256: FileSha256(file),
    }));
    fs.writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    const manifestFiles = [...files, inventoryFile];
    fs.writeFileSync(
      manifestFile,
      `${manifestFiles
        .map((file) => `${FileSha256(file)}  ${path.relative(directory, file)}`)
        .join('\n')}\n`,
      { flag: 'wx' },
    );
    this.Notify(session);
    return session;
  }

  Report(experimentId: string): unknown {
    const session = this.Get(experimentId);
    const summaryFile = path.join(this.Directory(experimentId), 'processed', 'summary.json');
    return {
      session,
      summary: fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null,
      files: WalkFiles(this.Directory(experimentId)).map((file) =>
        path.relative(this.Directory(experimentId), file),
      ),
    };
  }

  ResolveDownload(experimentId: string, requested: string): string {
    const directory = this.Directory(experimentId);
    const file = path.resolve(directory, requested);
    if (file !== directory && !file.startsWith(`${directory}${path.sep}`))
      throw new Error('Invalid file path');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('File not found');
    return file;
  }

  private ParseReference(
    input: Record<string, unknown>,
  ): { x: number; y: number; yaw: number; marker_id?: string } | undefined {
    const x = Number(input.x);
    const y = Number(input.y);
    const yaw = Number(input.yaw);
    if (![x, y, yaw].every(Number.isFinite)) return undefined;
    return { x, y, yaw, marker_id: SafeText(input.marker_id, 40) || undefined };
  }

  private RequireState(session: ExperimentSession, allowed: ExperimentState[]): void {
    if (!allowed.includes(session.state))
      throw new Error(`Operation is invalid while experiment state=${session.state}`);
  }

  private Checkpoints(experimentId: string): Array<{ marker_id: string; timestamp_ms: number }> {
    const file = path.join(this.Directory(experimentId), 'raw', 'ground_truth.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            marker_id: string;
            timestamp_ms: number;
          },
      );
  }

  private Directory(experimentId: string): string {
    this.ValidateExperimentId(experimentId);
    const legacy = path.join(this.OutputRoot, experimentId);
    if (fs.existsSync(legacy)) return legacy;
    for (const folder of Object.values(OutputFolderByRunType)) {
      const categorized = path.join(this.OutputRoot, folder, experimentId);
      if (fs.existsSync(categorized)) return categorized;
    }
    return legacy;
  }

  private ResolveAblationSourceDirectory(experimentId: string): string {
    this.ValidateExperimentId(experimentId);
    const acceptedRoot = path.join(path.dirname(this.OutputRoot), 'Accepted');
    const matches = FindExperimentDirectories(acceptedRoot)
      .filter((directory) => path.basename(directory) === experimentId)
      .filter((directory) => fs.existsSync(path.join(directory, 'config', 'session.json')));
    if (matches.length !== 1)
      throw new Error(
        matches.length ? 'Ablation source ID is ambiguous' : 'Ablation source was not found',
      );
    return matches[0]!;
  }

  private ActiveMapFile(): string {
    const maps = path.join(this.RepoRoot, 'maps');
    let name = 'ruang_utama';
    try {
      const configured = JSON.parse(
        fs.readFileSync(path.join(maps, 'active_map.json'), 'utf8'),
      ) as { name?: unknown };
      if (typeof configured.name === 'string' && /^[A-Za-z0-9_-]+$/.test(configured.name))
        name = configured.name;
    } catch {
      // The established default remains valid before the first explicit selection.
    }
    const file = path.join(maps, `${name}.bin`);
    if (!fs.existsSync(file)) throw new Error(`Active map binary is unavailable: ${file}`);
    return file;
  }

  private SessionFile(experimentId: string): string {
    return path.join(this.Directory(experimentId), 'config', 'session.json');
  }

  private RemoteDirectory(experimentId: string): string {
    this.ValidateExperimentId(experimentId);
    return `/tmp/luckfox_experiments/${experimentId}`;
  }

  private ValidateExperimentId(experimentId: string): void {
    if (!/^[A-Za-z0-9_-]{10,160}$/.test(experimentId)) throw new Error('Invalid experiment ID');
  }

  private WriteSession(session: ExperimentSession): void {
    const file = this.SessionFile(session.experiment_id);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`);
    fs.renameSync(temporary, file);
    this.Notify(session);
  }

  private GitValue(args: string[]): string {
    try {
      return execFileSync('git', args, { cwd: this.RepoRoot, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  private async CleanBoardStorage(): Promise<number> {
    const output = await this.RunSsh(
      `set -eu
mkdir -p /tmp/luckfox_experiments
for stale in /tmp/luckfox_experiments/*; do
  test -d "$stale" || continue
  if test -f "$stale/pid" && kill -0 "$(cat "$stale/pid")" 2>/dev/null; then
    continue
  fi
  rm -rf "$stale"
done
: > /tmp/localize_scans.jsonl
: > /tmp/localize_uart.log
sync
df -k /tmp | awk 'NR == 2 { print $4 }'`,
      15_000,
    );
    const availableKb = Number(output.trim().split(/\s+/).at(-1));
    if (!Number.isFinite(availableKb) || availableKb <= 0)
      throw new Error(`Cannot verify available board /tmp storage: ${output.trim()}`);
    return availableKb;
  }

  private async RunSsh(command: string, timeout: number): Promise<string> {
    return this.RunSshTarget(this.BoardSshTarget, command, timeout);
  }

  private async RunSshTarget(target: string, command: string, timeout: number): Promise<string> {
    const result = await ExecFileAsync('ssh', [...this.SshOptions(), target, command], {
      cwd: this.RepoRoot,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return `${result.stdout}${result.stderr}`;
  }

  private async StreamFileToSsh(
    target: string,
    command: string,
    inputFile: string,
    outputFile: string | undefined,
    timeout: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', [...this.SshOptions(), target, command], {
        cwd: this.RepoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const input = fs.createReadStream(inputFile);
      const output = outputFile ? fs.createWriteStream(outputFile, { flags: 'wx' }) : undefined;
      const errors: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        Finish(new Error(`Board replay timed out after ${Math.round(timeout / 1000)} seconds`));
      }, timeout);
      const Finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.destroy();
        if (error) {
          output?.destroy();
          if (outputFile && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
          reject(error);
        } else resolve();
      };
      input.on('error', (error) => Finish(error));
      child.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') Finish(error);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errors.reduce((sum, item) => sum + item.length, 0) < 1024 * 1024)
          errors.push(Buffer.from(chunk));
      });
      if (output) child.stdout.pipe(output);
      else child.stdout.resume();
      input.pipe(child.stdin);
      child.on('error', (error) => Finish(error));
      child.on('close', (code) => {
        if (code === 0) {
          if (output && !output.writableFinished) output.once('finish', () => Finish());
          else Finish();
        } else
          Finish(
            new Error(
              `Board replay SSH exited ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`,
            ),
          );
      });
    });
  }

  private async StreamFileToTcp(
    host: string,
    port: number,
    inputFile: string,
    outputFile: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;
      let socket: net.Socket | undefined;
      let input: fs.ReadStream | undefined;
      let output: fs.WriteStream | undefined;
      const Abort = () => Finish(new Error('Board replay was cancelled'));
      const Finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', Abort);
        input?.destroy();
        socket?.destroy();
        if (error) {
          output?.destroy();
          if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
          reject(error);
        } else resolve();
      };
      const Connect = () => {
        if (settled) return;
        socket = net.createConnection({ host, port, allowHalfOpen: true });
        const Retry = (error: Error) => {
          socket?.destroy();
          if (Date.now() - startedAt < 10_000) setTimeout(Connect, 250);
          else Finish(error);
        };
        socket.once('error', Retry);
        socket.once('connect', () => {
          socket!.off('error', Retry);
          input = fs.createReadStream(inputFile);
          output = fs.createWriteStream(outputFile, { flags: 'wx' });
          input.on('error', (error) => Finish(error));
          output.on('error', (error) => Finish(error));
          socket!.on('error', (error) => Finish(error));
          socket!.pipe(output);
          input.pipe(socket!);
          socket!.once('end', () => {
            if (output!.writableFinished) Finish();
            else output!.once('finish', () => Finish());
          });
        });
      };
      const timer = setTimeout(
        () => Finish(new Error(`Board replay TCP stream timed out after ${timeout / 1000}s`)),
        timeout,
      );
      signal?.addEventListener('abort', Abort, { once: true });
      if (signal?.aborted) {
        Abort();
        return;
      }
      Connect();
    });
  }

  private SshOptions(): string[] {
    return [
      ...(fs.existsSync(this.BoardSshKey) ? ['-i', this.BoardSshKey] : []),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ];
  }

  private async CopyRemote(remote: string, destination: string, optional: boolean): Promise<void> {
    if (fs.existsSync(destination)) throw new Error(`Refusing overwrite: ${destination}`);
    const blockSize = 64 * 1024;
    const blocksPerChunk = 4;
    let file: number | undefined;
    let failure: unknown;
    try {
      const sizeOutput = await this.RunSsh(`wc -c < '${remote}'`, 10_000);
      const expectedBytes = Number(sizeOutput.trim().split(/\s+/).at(-1));
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
        throw new Error(`Cannot determine remote capture size: ${sizeOutput.trim()}`);
      file = fs.openSync(destination, 'wx');
      let writtenBytes = 0;
      for (let skip = 0; skip * blockSize < expectedBytes; skip += blocksPerChunk) {
        const result = await ExecFileAsync(
          'ssh',
          [
            ...this.SshOptions(),
            this.BoardSshTarget,
            `dd if='${remote}' bs=${blockSize} skip=${skip} count=${blocksPerChunk} 2>/dev/null`,
          ],
          {
            cwd: this.RepoRoot,
            timeout: 15_000,
            maxBuffer: blockSize * blocksPerChunk + 1024,
            encoding: 'buffer',
          },
        );
        const chunk = Buffer.isBuffer(result.stdout)
          ? result.stdout
          : Buffer.from(result.stdout as string);
        fs.writeSync(file, chunk);
        writtenBytes += chunk.length;
      }
      if (writtenBytes !== expectedBytes)
        throw new Error(
          `Remote capture size mismatch for ${path.basename(remote)}: expected ${expectedBytes}, downloaded ${writtenBytes}`,
        );
    } catch (error) {
      failure = error;
    } finally {
      if (file !== undefined) fs.closeSync(file);
    }
    if (!failure) return;
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    if (!optional) throw failure;
  }

  private async CopyRemoteVerified(
    remote: string,
    destination: string,
    expectedSha256: string,
  ): Promise<void> {
    if (fs.existsSync(destination) && FileSha256(destination) === expectedSha256) return;
    const temporary = `${destination}.download-${crypto.randomBytes(6).toString('hex')}`;
    await this.CopyRemote(remote, temporary, false);
    const downloadedSha256 = FileSha256(temporary);
    if (downloadedSha256 !== expectedSha256) {
      fs.unlinkSync(temporary);
      throw new Error(
        `Capture checksum mismatch for ${path.basename(destination)}: expected ${expectedSha256}, downloaded ${downloadedSha256}`,
      );
    }
    if (fs.existsSync(destination)) {
      const previousSha256 = FileSha256(destination);
      fs.renameSync(
        destination,
        `${destination}.checksum-mismatch-${previousSha256.slice(0, 12)}.bak`,
      );
    }
    fs.renameSync(temporary, destination);
  }
}
