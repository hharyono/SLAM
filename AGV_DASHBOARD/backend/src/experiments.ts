import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
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
  source_experiment_id?: string;
  error?: string;
};

export type CreateSessionInput = {
  condition: string;
  run_type: string;
  trial: number;
  route_id?: string;
  zone?: string;
  ground_truth_method?: string;
  robot_id?: string;
  source_experiment_id?: string;
};

type ExperimentManagerOptions = {
  repoRoot: string;
  outputRoot: string;
  boardSshTarget: string;
  boardSshKey: string;
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
const Events = new Set([
  'ROUTE_START',
  'ROUTE_END',
  'KIDNAP_START',
  'KIDNAP_RELEASE',
  'NOTE',
  'ANOMALY',
  'ROBOT_CONNECTED',
  'ROBOT_DISCONNECTED',
  'MISSION_START_SENT',
  'MISSION_STOP_SENT',
  'MISSION_ACK',
  'RESOURCE_IDLE_START',
  'RESOURCE_IDLE_END',
  'RESOURCE_TRACKING_START',
  'RESOURCE_TRACKING_END',
  'RESOURCE_GLOBAL_START',
  'RESOURCE_GLOBAL_END',
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

function FileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  private readonly Notify: (session: ExperimentSession) => void;
  private ActiveExperimentId?: string;
  private PreviousSequence?: number;

  constructor(options: ExperimentManagerOptions) {
    this.RepoRoot = options.repoRoot;
    this.OutputRoot = options.outputRoot;
    this.BoardSshTarget = options.boardSshTarget;
    this.BoardSshKey = options.boardSshKey;
    this.Notify = options.notify;
    fs.mkdirSync(this.OutputRoot, { recursive: true });
    for (const session of this.List()) {
      if (
        session.state === 'starting' ||
        session.state === 'capturing' ||
        session.state === 'stopping'
      ) {
        this.ActiveExperimentId = session.experiment_id;
        break;
      }
    }
  }

  List(): ExperimentSession[] {
    if (!fs.existsSync(this.OutputRoot)) return [];
    return fs
      .readdirSync(this.OutputRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const file = path.join(this.OutputRoot, entry.name, 'config', 'session.json');
        if (!fs.existsSync(file)) return [];
        try {
          return [JSON.parse(fs.readFileSync(file, 'utf8')) as ExperimentSession];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.created_unix_ms - left.created_unix_ms);
  }

  Get(experimentId: string): ExperimentSession {
    this.ValidateExperimentId(experimentId);
    const file = this.SessionFile(experimentId);
    if (!fs.existsSync(file)) throw new Error('Experiment not found');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExperimentSession;
  }

  GetActive(): ExperimentSession | undefined {
    return this.ActiveExperimentId ? this.Get(this.ActiveExperimentId) : undefined;
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
    const zone = SafeText(input.zone || 'cross_room', 32);
    if (!Routes.has(routeId)) throw new Error('Invalid route ID');
    if (!Zones.has(zone)) throw new Error('Invalid zone');
    const sourceExperimentId = SafeText(input.source_experiment_id, 160) || undefined;
    if (runType === 'ablation') {
      if (!sourceExperimentId) throw new Error('A source experiment is required for ablation');
      const source = this.Get(sourceExperimentId);
      const sourceRawScan = path.join(this.Directory(source.experiment_id), 'raw', 'raw_scans.csv');
      if (!fs.existsSync(sourceRawScan) || fs.statSync(sourceRawScan).size === 0)
        throw new Error('The source experiment has no raw scan recording');
    }
    const commit = this.GitValue(['rev-parse', '--short=12', 'HEAD']) || 'no_commit';
    const now = new Date();
    const experimentId = `${TimestampId(now)}_${input.condition}_${runType}_${String(input.trial).padStart(2, '0')}_${commit}`;
    const directory = this.Directory(experimentId);
    fs.mkdirSync(directory, { recursive: false });
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
      zone,
      ground_truth_method: SafeText(input.ground_truth_method || 'surveyed_floor_markers', 80),
      robot_id: SafeText(input.robot_id || 'AGV-001', 32),
      state: 'created',
      created_unix_ms: now.getTime(),
      status_count: 0,
      source_experiment_id: sourceExperimentId,
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
    fs.writeFileSync(path.join(directory, 'config', 'markers.json'), '[]\n', { flag: 'wx' });
    const mapFile = path.join(this.RepoRoot, 'maps', 'ruang_utama.bin');
    fs.writeFileSync(
      path.join(directory, 'config', 'map.json'),
      `${JSON.stringify(
        {
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
    const mapFile = path.join(this.RepoRoot, 'maps', 'ruang_utama.bin');
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
    session.state = 'starting';
    session.error = undefined;
    this.ActiveExperimentId = experimentId;
    this.WriteSession(session);
    const remoteDir = this.RemoteDirectory(experimentId);
    const command = `set -eu
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
export LUCKFOX_RAW_SCAN_LOG='${remoteDir}/raw_scans.csv'
nohup /usr/bin/localize_uart "$MAP" "$UART" "$BAUD" >'${remoteDir}/runtime.log' 2>&1 &
echo $! > '${remoteDir}/pid'
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
      await this.RunSsh('/etc/init.d/S99zzlocalize_uart start', 10_000).catch(() => undefined);
      this.ActiveExperimentId = undefined;
      throw error;
    }
  }

  async Stop(experimentId: string): Promise<ExperimentSession> {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing', 'error']);
    session.state = 'stopping';
    this.WriteSession(session);
    const remoteDir = this.RemoteDirectory(experimentId);
    try {
      await this.RunSsh(
        `if test -f '${remoteDir}/pid'; then kill $(cat '${remoteDir}/pid') 2>/dev/null || true; fi`,
        10_000,
      );
      const raw = path.join(this.Directory(experimentId), 'raw');
      await this.CopyRemote(
        `${remoteDir}/telemetry.jsonl`,
        path.join(raw, 'telemetry.jsonl'),
        false,
      );
      await this.CopyRemote(`${remoteDir}/raw_scans.csv`, path.join(raw, 'raw_scans.csv'), true);
      await this.CopyRemote(`${remoteDir}/runtime.log`, path.join(raw, 'runtime.log'), true);
      await this.CopyRemote(`${remoteDir}/system.txt`, path.join(raw, 'system.txt'), false);
      await this.CopyRemote(
        `${remoteDir}/runtime_default.env`,
        path.join(raw, 'runtime_default.env'),
        false,
      );
      await this.RunSsh('/etc/init.d/S99zzlocalize_uart start', 10_000);
      session.state = 'stopped';
      session.stopped_unix_ms = Date.now();
      this.ActiveExperimentId = undefined;
      this.PreviousSequence = undefined;
      this.WriteSession(session);
      return session;
    } catch (error) {
      session.state = 'error';
      session.error = (error as Error).message;
      this.WriteSession(session);
      throw error;
    }
  }

  async RunAblation(experimentId: string): Promise<ExperimentSession> {
    const session = this.Get(experimentId);
    this.RequireState(session, ['created', 'error']);
    if (session.run_type !== 'ablation' || !session.source_experiment_id)
      throw new Error('This session is not configured for ablation replay');
    if (this.ActiveExperimentId && this.ActiveExperimentId !== experimentId)
      throw new Error('Another experiment is still active');
    const sourceDirectory = this.Directory(session.source_experiment_id);
    const rawScan = path.join(sourceDirectory, 'raw', 'raw_scans.csv');
    const replayBinary = path.join(this.RepoRoot, 'LUCKFOX_LOCALIZER', 'build', 'localize_replay');
    const mapFile = path.join(this.RepoRoot, 'maps', 'ruang_utama.bin');
    if (!fs.existsSync(replayBinary)) throw new Error('localize_replay has not been built');
    session.state = 'starting';
    session.started_unix_ms = Date.now();
    session.error = undefined;
    this.ActiveExperimentId = experimentId;
    this.WriteSession(session);
    try {
      fs.writeFileSync(
        path.join(this.Directory(experimentId), 'config', 'ablation_source.json'),
        `${JSON.stringify(
          {
            source_experiment_id: session.source_experiment_id,
            source_raw_scan: rawScan,
            source_raw_scan_sha256: FileSha256(rawScan),
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      );
      for (const variant of [
        'local_only',
        'local_global',
        'single_resolution',
        'multi_resolution',
      ]) {
        const result = await ExecFileAsync(replayBinary, [mapFile, rawScan, '--mode', variant], {
          cwd: this.RepoRoot,
          timeout: 30 * 60_000,
          maxBuffer: 256 * 1024 * 1024,
        });
        fs.writeFileSync(
          path.join(this.Directory(experimentId), 'raw', `replay_${variant}.jsonl`),
          result.stdout,
          { flag: 'wx' },
        );
      }
      session.state = 'stopped';
      session.stopped_unix_ms = Date.now();
      this.ActiveExperimentId = undefined;
      this.WriteSession(session);
      return session;
    } catch (error) {
      session.state = 'error';
      session.error = (error as Error).message;
      this.ActiveExperimentId = undefined;
      this.WriteSession(session);
      throw error;
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

  RecordEvent(experimentId: string, input: Record<string, unknown>): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing']);
    const event = SafeText(input.event, 40).toUpperCase();
    if (!Events.has(event)) throw new Error('Invalid event');
    const reference = this.ParseReference(input);
    const data: Record<string, unknown> = {};
    if (event.startsWith('DYNAMIC_OCCLUSION_')) {
      const isDynamicSession =
        session.run_type === 'dynamic_occluded' ||
        (session.run_type === 'route' && session.condition === 'dynamic_occluded');
      if (!isDynamicSession || session.condition !== 'dynamic_occluded')
        throw new Error('Dynamic-occlusion events require a dynamic_occluded test session');
      const direction = SafeText(input.pedestrian_direction, 20).toUpperCase();
      if (!['H1_TO_H2', 'H2_TO_H1'].includes(direction))
        throw new Error('Pedestrian direction must be H1_TO_H2 or H2_TO_H1');
      data.trigger_marker = SafeText(input.trigger_marker || 'T0', 20);
      data.pedestrian_direction = direction;
    }
    if (event.startsWith('RESOURCE_')) {
      if (session.run_type !== 'resource')
        throw new Error('Resource events require a resource session');
      const repetition = Number(input.repetition);
      if (!Number.isInteger(repetition) || repetition < 1 || repetition > 5)
        throw new Error('Resource repetition must be from 1 to 5');
      data.repetition = repetition;
    }
    const eventsFile = path.join(this.Directory(experimentId), 'raw', 'operator_events.jsonl');
    if (event.startsWith('DYNAMIC_OCCLUSION_') || event.startsWith('RESOURCE_')) {
      const previousEvents = fs
        .readFileSync(eventsFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; data?: Record<string, unknown> });
      const duplicate = previousEvents.some(
        (row) =>
          row.event === event &&
          (data.repetition === undefined || row.data?.repetition === data.repetition),
      );
      if (duplicate) throw new Error(`${event} has already been recorded for this repetition`);
      if (event.endsWith('_END')) {
        const startEvent = event.replace(/_END$/, '_START');
        const matchingStart = previousEvents.find(
          (row) =>
            row.event === startEvent &&
            (data.repetition === undefined || row.data?.repetition === data.repetition),
        );
        if (!matchingStart) throw new Error(`Record ${startEvent} before ${event}`);
        if (
          event === 'DYNAMIC_OCCLUSION_END' &&
          matchingStart.data?.pedestrian_direction !== data.pedestrian_direction
        )
          throw new Error('Pedestrian direction must remain unchanged during the crossing');
      }
    }
    AppendJsonLine(eventsFile, {
      schema: 'luckfox.experiment.event.v1',
      timestamp_ms: Date.now(),
      event,
      source: 'operator',
      reference,
      data,
      notes: SafeText(input.notes, 500),
    });
    this.Notify(session);
    return session;
  }

  RecordCheckpoint(
    experimentId: string,
    input: Record<string, unknown>,
    status: ExperimentRobotStatus | undefined,
  ): ExperimentSession {
    const session = this.Get(experimentId);
    this.RequireState(session, ['capturing']);
    if (!status || !status.online) throw new Error('Robot status is unavailable');
    const reference = this.ParseReference(input);
    if (!reference) throw new Error('Reference pose is required');
    const markerId = SafeText(input.marker_id, 40);
    if (!markerId) throw new Error('Marker ID is required');
    AppendJsonLine(path.join(this.Directory(experimentId), 'raw', 'ground_truth.jsonl'), {
      schema: 'luckfox.experiment.checkpoint.v1',
      timestamp_ms: Date.now(),
      marker_id: markerId,
      zone: SafeText(input.zone || session.zone, 32),
      reference,
      estimate: status.pose,
      robot_timestamp_ms: status.timestamp_ms,
      backend_received_ms: status.received_ms,
      robot_sequence: status.seq,
      notes: SafeText(input.notes, 500),
    });
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
    if (['route', 'dynamic_occluded'].includes(session.run_type) && checkpointCount < 8)
      throw new Error(
        `A route-based test requires all 8 marker checkpoints; found ${checkpointCount}`,
      );
    const eventFile = path.join(raw, 'operator_events.jsonl');
    const recordedEvents = fs.existsSync(eventFile)
      ? fs
          .readFileSync(eventFile, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event?: string; timestamp_ms?: number })
      : [];
    if (
      session.run_type === 'dynamic_occluded' ||
      (session.run_type === 'route' && session.condition === 'dynamic_occluded')
    ) {
      const starts = recordedEvents.filter((row) => row.event === 'DYNAMIC_OCCLUSION_START');
      const ends = recordedEvents.filter((row) => row.event === 'DYNAMIC_OCCLUSION_END');
      if (starts.length !== 1 || ends.length !== 1)
        throw new Error('A dynamic-occlusion trial requires exactly one START and one END event');
      const duration = Number(ends[0]!.timestamp_ms) - Number(starts[0]!.timestamp_ms);
      if (duration < 2_500 || duration > 3_500)
        throw new Error(
          `Dynamic crossing must take 3 ± 0.5 seconds; recorded ${(duration / 1000).toFixed(2)} seconds`,
        );
    }
    if (
      session.run_type === 'kidnapped' &&
      (JsonLineCount('operator_events.jsonl', 'KIDNAP_RELEASE') !== 1 || checkpointCount < 1)
    )
      throw new Error('A kidnapped trial requires one release event and one final checkpoint');
    if (session.run_type === 'resource') {
      for (const prefix of ['RESOURCE_IDLE', 'RESOURCE_TRACKING', 'RESOURCE_GLOBAL']) {
        const starts = recordedEvents.filter((row) => row.event === `${prefix}_START`);
        const ends = recordedEvents.filter((row) => row.event === `${prefix}_END`);
        if (starts.length !== 5 || ends.length !== 5)
          throw new Error(`${prefix} requires five complete 60-second intervals`);
        for (let index = 0; index < 5; index++) {
          const duration = Number(ends[index]!.timestamp_ms) - Number(starts[index]!.timestamp_ms);
          if (duration < 55_000 || duration > 65_000)
            throw new Error(`${prefix} repetition ${index + 1} must be approximately 60 seconds`);
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

  private Directory(experimentId: string): string {
    this.ValidateExperimentId(experimentId);
    return path.join(this.OutputRoot, experimentId);
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

  private async RunSsh(command: string, timeout: number): Promise<string> {
    const result = await ExecFileAsync(
      'ssh',
      [...this.SshOptions(), this.BoardSshTarget, command],
      { cwd: this.RepoRoot, timeout, maxBuffer: 1024 * 1024 },
    );
    return `${result.stdout}${result.stderr}`;
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
    try {
      await ExecFileAsync(
        'scp',
        ['-q', ...this.SshOptions(), `${this.BoardSshTarget}:${remote}`, destination],
        { cwd: this.RepoRoot, timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      if (!optional) throw error;
    }
  }
}
