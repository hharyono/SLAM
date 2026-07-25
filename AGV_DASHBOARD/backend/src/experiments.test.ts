import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ExperimentManager,
  ExperimentOutputFolder,
  type ExperimentRobotStatus,
  type ExperimentSession,
} from './experiments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function TestManager(outputRoot: string): ExperimentManager {
  const manager = new ExperimentManager({
    repoRoot,
    outputRoot,
    boardSshTarget: 'unused',
    boardSshKey: 'unused',
    notify: () => undefined,
  });
  Object.assign(manager, {
    RunSsh: async (command: string) => (command.includes('df -k /tmp') ? '90000\n' : ''),
  });
  return manager;
}

function SessionDirectory(outputRoot: string, session: ExperimentSession): string {
  return path.join(outputRoot, ExperimentOutputFolder(session.run_type), session.experiment_id);
}

function RouteMarkers() {
  return Array.from({ length: 8 }, (_, index) => ({
    marker_id: `M${index + 1}`,
    zone: index < 4 ? 'room_1' : 'room_2',
    x: 1 + index,
    y: 2 + index,
    yaw: index * 0.1,
  }));
}

function OnlineStatus(sequence = 1): ExperimentRobotStatus {
  return {
    robot_id: 'AGV-001',
    seq: sequence,
    timestamp_ms: Date.now(),
    pose: {
      x: 1,
      y: 2,
      yaw: 0,
      score: 0.95,
      valid: true,
      mode: 'tracking',
    },
    mission_running: true,
    online: true,
    received_ms: Date.now(),
  };
}

function ReplayReadyTelemetry(): string {
  return `${[
    {
      schema: 'luckfox.localization.config.v1',
      minimum_range_m: 0.05,
      maximum_range_m: 12,
      linear_window_m: 0.5,
      angular_window_rad: 0.35,
      linear_step_m: 0.05,
      angular_step_rad: 0.017,
      minimum_score: 0.9,
      lost_after_rejections: 3,
      recovery_confirmations: 3,
    },
    {
      schema: 'luckfox.localization.scan.v1',
      accepted: true,
      x_m: 1,
      y_m: 2,
      yaw_rad: 0,
    },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')}\n`;
}

test('cancel removes an active test from board tracking and backend storage', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-cancel-test-'));
  const commands: string[] = [];
  try {
    const manager = TestManager(outputRoot);
    Object.assign(manager, {
      RunSsh: async (command: string) => {
        commands.push(command);
        return command.includes('df -k /tmp') ? '90000\n' : '';
      },
    });
    const created = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    const directory = SessionDirectory(outputRoot, created);
    await manager.Start(created.experiment_id);

    const result = await manager.Cancel(created.experiment_id);

    assert.deepEqual(result, { experiment_id: created.experiment_id, deleted: true });
    assert.equal(manager.GetActive(), undefined);
    assert.equal(fs.existsSync(directory), false);
    assert.ok(
      commands.some(
        (command) =>
          command.includes(`/tmp/luckfox_experiments/${created.experiment_id}`) &&
          command.includes('/etc/init.d/S99zzlocalize_uart start') &&
          command.includes('rm -rf'),
      ),
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('cancel aborts and deletes an ablation replay while it is starting', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-ablation-cancel-test-'));
  try {
    const manager = TestManager(outputRoot);
    const created = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    const directory = SessionDirectory(outputRoot, created);
    const sessionFile = path.join(directory, 'config', 'session.json');
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify(
        {
          ...created,
          run_type: 'ablation',
          state: 'starting',
          ablation_execution_target: 'host',
        },
        null,
        2,
      )}\n`,
    );
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () =>
      Object.assign(manager, { ActiveExperimentId: undefined }),
    );
    Object.assign(manager, {
      ActiveExperimentId: created.experiment_id,
      AblationAbortControllers: new Map([[created.experiment_id, controller]]),
    });

    const result = await manager.Cancel(created.experiment_id);

    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(result, { experiment_id: created.experiment_id, deleted: true });
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('cancel refuses to delete a finalized test', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-cancel-finalized-test-'));
  try {
    const manager = TestManager(outputRoot);
    const created = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    const directory = SessionDirectory(outputRoot, created);
    const sessionFile = path.join(directory, 'config', 'session.json');
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ ...created, state: 'finalized' }, null, 2)}\n`,
    );

    assert.rejects(() => manager.Cancel(created.experiment_id), /state=finalized/);
    assert.equal(fs.existsSync(directory), true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('dynamic-occlusion session records six reproducible marker events', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-dynamic-test-'));
  const originalNow = Date.now;
  try {
    const manager = TestManager(outputRoot);
    const created = manager.Create({
      condition: 'dynamic_occluded',
      run_type: 'dynamic_occluded',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    await manager.Start(created.experiment_id);
    const firstMarkerStatus = OnlineStatus();
    firstMarkerStatus.pose.x = 1;
    firstMarkerStatus.pose.y = 2;
    manager.RecordCheckpoint(created.experiment_id, { marker_id: 'M1' }, firstMarkerStatus);
    for (const [index, markerId] of ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'].entries()) {
      Date.now = () => 10_000 + index * 5_000;
      const status = OnlineStatus(index + 1);
      status.pose.x = index + 2;
      status.pose.y = index + 3;
      status.pose.yaw = (index + 1) * 0.1;
      manager.RecordEvent(
        created.experiment_id,
        {
          event: 'DYNAMIC_OCCLUSION_START',
          trigger_marker: markerId,
        },
        status,
      );
      Date.now = () => 14_000 + index * 5_000;
      manager.RecordEvent(created.experiment_id, {
        event: 'DYNAMIC_OCCLUSION_END',
        trigger_marker: markerId,
      });
    }

    const events = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, created), 'raw', 'operator_events.jsonl'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
    assert.deepEqual(
      events.map((row) => row.event),
      Array.from({ length: 6 }).flatMap(() => ['DYNAMIC_OCCLUSION_START', 'DYNAMIC_OCCLUSION_END']),
    );
    assert.equal(events[0]!.data.trigger_marker, 'M2');
    assert.equal(events[0]!.data.occluder_direction, 'LEFT_TO_RIGHT');
    assert.deepEqual(manager.Get(created.experiment_id).dynamic_occlusion_completed_marker_ids, [
      'M2',
      'M3',
      'M4',
      'M5',
      'M6',
      'M7',
    ]);
    assert.equal(manager.Get(created.experiment_id).checkpoint_count, 7);
    assert.deepEqual(
      fs
        .readFileSync(
          path.join(SessionDirectory(outputRoot, created), 'raw', 'ground_truth.jsonl'),
          'utf8',
        )
        .trim()
        .split(/\r?\n/)
        .map((line) => (JSON.parse(line) as { marker_id: string }).marker_id),
      ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    );
  } finally {
    Date.now = originalNow;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('dynamic OCCLUSION END is recorded automatically after four seconds', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-dynamic-auto-end-'));
  try {
    const manager = TestManager(outputRoot);
    const created = manager.Create({
      condition: 'dynamic_occluded',
      run_type: 'dynamic_occluded',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    await manager.Start(created.experiment_id);
    const firstMarkerStatus = OnlineStatus();
    firstMarkerStatus.pose.x = 1;
    firstMarkerStatus.pose.y = 2;
    manager.RecordCheckpoint(created.experiment_id, { marker_id: 'M1' }, firstMarkerStatus);
    const status = OnlineStatus();
    status.pose.x = 2;
    status.pose.y = 3;
    status.pose.yaw = 0.1;
    manager.RecordEvent(
      created.experiment_id,
      {
        event: 'DYNAMIC_OCCLUSION_START',
        trigger_marker: 'M2',
      },
      status,
    );
    await new Promise((resolve) => setTimeout(resolve, 4_150));

    const updated = manager.Get(created.experiment_id);
    assert.equal(updated.dynamic_occlusion_active_marker_id, undefined);
    assert.deepEqual(updated.dynamic_occlusion_completed_marker_ids, ['M2']);
    assert.ok((updated.dynamic_occlusion_durations_ms?.M2 || 0) >= 3_900);
    assert.ok((updated.dynamic_occlusion_durations_ms?.M2 || 0) <= 4_300);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('dynamic condition is rejected by the regular route test', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-dynamic-test-'));
  try {
    const manager = TestManager(outputRoot);
    assert.throws(
      () =>
        manager.Create({
          condition: 'dynamic_occluded',
          run_type: 'route',
          trial: 1,
        }),
      /standalone dynamic_occluded test/,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('dynamic test requires dynamic condition metadata', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-dynamic-test-'));
  try {
    const manager = TestManager(outputRoot);
    assert.throws(
      () =>
        manager.Create({
          condition: 'nominal',
          run_type: 'dynamic_occluded',
          trial: 1,
        }),
      /must use the dynamic_occluded condition/,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('all six TestPlanning run types can create valid sessions', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-six-tests-'));
  try {
    const manager = TestManager(outputRoot);
    const groundTruth = manager.Create({
      condition: 'nominal',
      run_type: 'ground_truth',
      trial: 1,
    });
    const route = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    fs.writeFileSync(
      path.join(SessionDirectory(outputRoot, route), 'raw', 'raw_scans.csv'),
      'scan_sequence,timestamp_ns,angle_rad,range_m,intensity\n1,1,0,1,0\n',
    );
    fs.writeFileSync(
      path.join(SessionDirectory(outputRoot, route), 'raw', 'telemetry.jsonl'),
      ReplayReadyTelemetry(),
    );
    fs.writeFileSync(
      path.join(SessionDirectory(outputRoot, route), 'config', 'session.json'),
      `${JSON.stringify({ ...route, state: 'finalized' }, null, 2)}\n`,
    );
    const acceptedCategory = path.join(path.dirname(outputRoot), 'Accepted', 'RV1103', 'ROUTE');
    fs.mkdirSync(acceptedCategory, { recursive: true });
    fs.renameSync(
      SessionDirectory(outputRoot, route),
      path.join(acceptedCategory, route.experiment_id),
    );
    const kidnapped = manager.Create({
      condition: 'nominal',
      run_type: 'kidnapped',
      trial: 1,
      route_id: 'KIDNAP_SAME_ROOM',
      kidnap_start_marker: RouteMarkers()[0],
      kidnap_target_marker: RouteMarkers()[1],
    });
    const dynamic = manager.Create({
      condition: 'dynamic_occluded',
      run_type: 'dynamic_occluded',
      trial: 1,
      route_id: 'R2_ROOM_2_TO_1',
      route_markers: RouteMarkers(),
    });
    const ablation = manager.Create({
      condition: 'nominal',
      run_type: 'ablation',
      trial: 1,
      source_experiment_id: route.experiment_id,
    });
    const resource = manager.Create({
      condition: 'nominal',
      run_type: 'resource',
      trial: 1,
    });

    assert.deepEqual(
      [groundTruth, route, kidnapped, dynamic, ablation, resource].map(
        (session) => session.run_type,
      ),
      ['ground_truth', 'route', 'kidnapped', 'dynamic_occluded', 'ablation', 'resource'],
    );
    assert.deepEqual(
      [groundTruth, route, kidnapped, dynamic, ablation, resource].map(
        (session) => session.raw_scan_capture_enabled,
      ),
      [false, true, true, false, false, false],
    );
    assert.deepEqual(dynamic.route_markers, RouteMarkers());
    assert.deepEqual(
      dynamic.dynamic_occlusion_markers?.map((marker) => marker.marker_id),
      ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('Resource LIVE stores one timed interval per phase without manual repetitions', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-resource-live-test-'));
  const originalNow = Date.now;
  try {
    const manager = TestManager(outputRoot);
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'resource',
      trial: 1,
      resource_mode: 'live_tracking',
    });
    await manager.Start(session.experiment_id);

    Date.now = () => 1_000;
    const started = manager.RecordEvent(session.experiment_id, {
      event: 'RESOURCE_IDLE_START',
    });
    assert.equal(started.resource_active_phase, 'RESOURCE_IDLE');
    assert.equal(started.resource_active_started_unix_ms, 1_000);
    assert.throws(
      () =>
        manager.RecordEvent(session.experiment_id, {
          event: 'RESOURCE_TRACKING_R1_START',
        }),
      /End RESOURCE_IDLE/,
    );

    Date.now = () => 61_000;
    const ended = manager.RecordEvent(session.experiment_id, {
      event: 'RESOURCE_IDLE_END',
    });
    assert.equal(ended.resource_active_phase, undefined);
    assert.deepEqual(ended.resource_completed_phases, ['RESOURCE_IDLE']);
    assert.throws(
      () => manager.RecordEvent(session.experiment_id, { event: 'RESOURCE_IDLE_START' }),
      /already been recorded/,
    );
  } finally {
    Date.now = originalNow;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('Resource Endurance records arbitrary start and end timestamps in its own session', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-resource-endurance-test-'));
  const originalNow = Date.now;
  try {
    const manager = TestManager(outputRoot);
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'resource',
      trial: 1,
      resource_mode: 'live_endurance',
    });
    await manager.Start(session.experiment_id);
    assert.throws(
      () => manager.RecordEvent(session.experiment_id, { event: 'RESOURCE_IDLE_START' }),
      /accepts only the Endurance interval/,
    );

    Date.now = () => 10_000;
    manager.RecordEvent(session.experiment_id, { event: 'RESOURCE_ENDURANCE_START' });
    Date.now = () => 47_321;
    const ended = manager.RecordEvent(session.experiment_id, {
      event: 'RESOURCE_ENDURANCE_END',
    });
    assert.deepEqual(ended.resource_completed_phases, ['RESOURCE_ENDURANCE']);

    const events = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'operator_events.jsonl'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string; timestamp_ms: number });
    assert.deepEqual(
      events.map((event) => [event.event, event.timestamp_ms]),
      [
        ['RESOURCE_ENDURANCE_START', 10_000],
        ['RESOURCE_ENDURANCE_END', 47_321],
      ],
    );
  } finally {
    Date.now = originalNow;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('RV1103 streams raw scans to backend storage using the board timestamp', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-streamed-scan-'));
  try {
    const manager = TestManager(outputRoot);
    Object.assign(manager, {
      RunSsh: async (command: string) => (command.includes('df -k /tmp') ? '16000\n' : ''),
    });
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    await manager.Start(session.experiment_id);

    const payload = Buffer.alloc(52);
    payload.writeBigUInt64BE(1234567890123456789n, 0);
    payload.writeFloatBE(-Math.PI, 8);
    payload.writeFloatBE(Math.PI, 12);
    payload.writeFloatBE(0.01, 16);
    payload.writeFloatBE(0.001, 20);
    payload.writeFloatBE(0.1, 24);
    payload.writeFloatBE(0.05, 28);
    payload.writeFloatBE(12, 32);
    payload.writeUInt32BE(1, 36);
    payload.writeFloatBE(0.25, 40);
    payload.writeFloatBE(1.5, 44);
    payload.writeFloatBE(7, 48);
    manager.RecordStreamedRawScan(42, payload);
    manager.RecordStreamedRawScan(42, payload);

    const rows = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'raw_scans.csv'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/);
    assert.equal(rows.length, 2);
    assert.equal(rows[0], 'scan_sequence,timestamp_ns,angle_rad,range_m,intensity');
    assert.match(rows[1]!, /^42,1234567890123456789,0\.250000000,1\.50000000,7\.00000000$/);
    assert.equal(manager.Get(session.experiment_id).raw_scan_capture_target, 'backend');
    assert.equal(manager.Get(session.experiment_id).board_tmp_available_kb_before_start, 16000);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('nested Accepted platform folders remain available as ablation sources', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-accepted-platform-'));
  const outputRoot = path.join(base, 'Ouputs');
  try {
    const manager = TestManager(outputRoot);
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    const source = SessionDirectory(outputRoot, session);
    fs.writeFileSync(
      path.join(source, 'raw', 'raw_scans.csv'),
      'scan_sequence,timestamp_ns,angle_rad,range_m,intensity\n1,1,0,1,0\n',
    );
    fs.writeFileSync(path.join(source, 'raw', 'telemetry.jsonl'), ReplayReadyTelemetry());
    fs.writeFileSync(
      path.join(source, 'config', 'session.json'),
      `${JSON.stringify({ ...session, state: 'finalized' }, null, 2)}\n`,
    );
    const acceptedCategory = path.join(base, 'Accepted', 'RV1103', 'ROUTE');
    fs.mkdirSync(acceptedCategory, { recursive: true });
    fs.renameSync(source, path.join(acceptedCategory, session.experiment_id));

    const sources = manager.ListAblationSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.experiment_id, session.experiment_id);
    assert.equal(sources[0]?.collection, 'accepted');
    assert.equal(sources[0]?.platform, 'RV1103');
    assert.equal(sources[0]?.readiness.firmware_format, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ground-truth session stores its marker reference in backend config', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-ground-truth-marker-'));
  try {
    const manager = TestManager(outputRoot);
    const reference = {
      marker_id: 'M1',
      zone: 'room_1',
      x: 1.65,
      y: 1.35,
      yaw: (85.1 * Math.PI) / 180,
    };
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'ground_truth',
      trial: 2,
      zone: 'room_1',
      reference_marker: reference,
    });
    assert.deepEqual(session.reference_marker, reference);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(SessionDirectory(outputRoot, session), 'config', 'markers.json'),
          'utf8',
        ),
      ),
      [reference],
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('kidnapped session locks marker A and marker B references', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-kidnap-markers-'));
  try {
    const manager = TestManager(outputRoot);
    const markerA = RouteMarkers()[0]!;
    const markerB = RouteMarkers()[1]!;
    assert.throws(
      () =>
        manager.Create({
          condition: 'nominal',
          run_type: 'kidnapped',
          trial: 1,
          route_id: 'KIDNAP_SAME_ROOM',
          kidnap_start_marker: markerA,
          kidnap_target_marker: markerA,
        }),
      /must be different/,
    );
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'kidnapped',
      trial: 2,
      route_id: 'KIDNAP_SAME_ROOM',
      kidnap_start_marker: markerA,
      kidnap_target_marker: markerB,
    });
    assert.deepEqual(session.kidnap_start_marker, markerA);
    assert.deepEqual(session.kidnap_target_marker, markerB);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(SessionDirectory(outputRoot, session), 'config', 'markers.json'),
          'utf8',
        ),
      ),
      [markerA, markerB],
    );

    await manager.Start(session.experiment_id);
    assert.throws(
      () => manager.RecordEvent(session.experiment_id, { event: 'KIDNAP_RELEASE' }),
      /KIDNAP_START/,
    );
    manager.RecordEvent(session.experiment_id, {
      event: 'KIDNAP_START',
      marker_id: 'UNTRUSTED',
      x: 999,
      y: 999,
      yaw: 999,
    });
    manager.RecordEvent(session.experiment_id, {
      event: 'KIDNAP_RELEASE',
      marker_id: 'UNTRUSTED',
      x: 999,
      y: 999,
      yaw: 999,
    });
    const status: ExperimentRobotStatus = {
      robot_id: 'AGV-001',
      seq: 10,
      timestamp_ms: 1_000,
      pose: {
        x: markerB.x,
        y: markerB.y,
        yaw: markerB.yaw,
        score: 0.95,
        valid: true,
        mode: 'tracking',
      },
      mission_running: true,
      online: true,
      received_ms: 1_010,
    };
    manager.RecordStatus(status);
    assert.equal(manager.Get(session.experiment_id).checkpoint_count, 0);
    status.seq++;
    status.pose.valid = false;
    manager.RecordStatus(status);
    assert.equal(manager.Get(session.experiment_id).kidnap_recovery_observed, true);
    status.seq++;
    status.pose.valid = true;
    status.pose.mode = 'global';
    manager.RecordStatus(status);
    assert.equal(manager.Get(session.experiment_id).checkpoint_count, 0);
    status.seq++;
    status.pose.mode = 'tracking';
    manager.RecordStatus(status);
    const automaticallyUpdated = manager.Get(session.experiment_id);
    assert.equal(automaticallyUpdated.checkpoint_count, 1);
    assert.ok(automaticallyUpdated.kidnap_auto_checkpoint_unix_ms);

    const events = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'operator_events.jsonl'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string; reference: unknown });
    assert.deepEqual(events[0]!.reference, {
      x: markerA.x,
      y: markerA.y,
      yaw: markerA.yaw,
      marker_id: markerA.marker_id,
    });
    assert.deepEqual(events[1]!.reference, {
      x: markerB.x,
      y: markerB.y,
      yaw: markerB.yaw,
      marker_id: markerB.marker_id,
    });
    const checkpoint = JSON.parse(
      fs
        .readFileSync(
          path.join(SessionDirectory(outputRoot, session), 'raw', 'ground_truth.jsonl'),
          'utf8',
        )
        .trim(),
    ) as { reference: unknown };
    assert.deepEqual(checkpoint.reference, {
      x: markerB.x,
      y: markerB.y,
      yaw: markerB.yaw,
      marker_id: markerB.marker_id,
    });
    assert.match(
      fs.readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'operator_events.jsonl'),
        'utf8',
      ),
      /KIDNAP_AUTO_CHECKPOINT/,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('session creation recreates a missing output category directory', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-output-test-'));
  try {
    const manager = TestManager(outputRoot);
    fs.rmSync(path.join(outputRoot, ExperimentOutputFolder('ground_truth')), {
      recursive: true,
      force: true,
    });

    const created = manager.Create({
      condition: 'nominal',
      run_type: 'ground_truth',
      trial: 1,
    });

    assert.ok(fs.existsSync(SessionDirectory(outputRoot, created)));
    assert.ok(
      fs.existsSync(path.join(SessionDirectory(outputRoot, created), 'config', 'session.json')),
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('route workflow derives start and end from 8 unique checkpoints', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-route-workflow-'));
  try {
    const manager = TestManager(outputRoot);
    const session = manager.Create({
      condition: 'nominal',
      run_type: 'route',
      trial: 1,
      route_id: 'R1_ROOM_1_TO_2',
      route_markers: RouteMarkers(),
    });
    await manager.Start(session.experiment_id);
    assert.deepEqual(session.route_markers, RouteMarkers());
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(SessionDirectory(outputRoot, session), 'config', 'markers.json'),
          'utf8',
        ),
      ),
      RouteMarkers(),
    );
    const status = {
      robot_id: 'AGV-001',
      seq: 10,
      timestamp_ms: 1_000,
      pose: {
        x: 1,
        y: 1,
        yaw: 0,
        score: 0.95,
        valid: true,
        mode: 'tracking' as const,
      },
      mission_running: true,
      online: true,
      received_ms: 1_010,
    };
    const checkpoint = (markerId: string) =>
      manager.RecordCheckpoint(
        session.experiment_id,
        { marker_id: markerId, zone: 'room_1', x: 1, y: 1, yaw: 0 },
        status,
      );

    const started = checkpoint('M1');
    assert.equal(started.checkpoint_count, 1);
    assert.equal(started.route_started, true);
    assert.equal(started.route_ended, false);
    const firstCheckpoint = JSON.parse(
      fs
        .readFileSync(
          path.join(SessionDirectory(outputRoot, session), 'raw', 'ground_truth.jsonl'),
          'utf8',
        )
        .trim(),
    ) as { reference: { x: number; y: number; yaw: number } };
    assert.deepEqual(firstCheckpoint.reference, {
      x: RouteMarkers()[0]!.x,
      y: RouteMarkers()[0]!.y,
      yaw: RouteMarkers()[0]!.yaw,
      marker_id: 'M1',
    });
    status.seq = 11;
    assert.equal(checkpoint('M1').checkpoint_count, 1);
    const replacedCheckpoints = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'ground_truth.jsonl'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { marker_id: string; robot_sequence: number });
    assert.equal(replacedCheckpoints.length, 1);
    assert.equal(replacedCheckpoints[0]!.marker_id, 'M1');
    assert.equal(replacedCheckpoints[0]!.robot_sequence, 11);
    const replacementEvents = fs
      .readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'operator_events.jsonl'),
        'utf8',
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string });
    assert.equal(replacementEvents.filter((row) => row.event === 'CHECKPOINT_REPLACED').length, 1);
    const unlocked = manager.UnlockCheckpoint(session.experiment_id, 'M1');
    assert.equal(unlocked.checkpoint_count, 0);
    assert.equal(unlocked.route_started, false);
    assert.equal(unlocked.route_ended, false);
    assert.deepEqual(unlocked.recorded_marker_ids, []);
    assert.equal(
      fs.readFileSync(
        path.join(SessionDirectory(outputRoot, session), 'raw', 'ground_truth.jsonl'),
        'utf8',
      ),
      '',
    );
    assert.equal(checkpoint('M1').checkpoint_count, 1);
    let ended = session;
    for (let marker = 2; marker <= 8; marker++) ended = checkpoint(`M${marker}`);
    assert.equal(ended.checkpoint_count, 8);
    assert.equal(ended.route_started, true);
    assert.equal(ended.route_ended, true);
    const reopened = manager.UnlockCheckpoint(session.experiment_id, 'M8');
    assert.equal(reopened.checkpoint_count, 7);
    assert.equal(reopened.route_ended, false);
    assert.equal(checkpoint('M8').route_ended, true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
