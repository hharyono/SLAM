import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ExperimentManager,
  ExperimentOutputFolder,
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
  Object.assign(manager, { RunSsh: async () => '' });
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

test('dynamic-occlusion session records one reproducible crossing', async () => {
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

    Date.now = () => 10_000;
    manager.RecordEvent(created.experiment_id, {
      event: 'DYNAMIC_OCCLUSION_START',
      trigger_marker: 'T0',
      pedestrian_direction: 'H1_TO_H2',
    });
    Date.now = () => 13_000;
    manager.RecordEvent(created.experiment_id, {
      event: 'DYNAMIC_OCCLUSION_END',
      trigger_marker: 'T0',
      pedestrian_direction: 'H1_TO_H2',
    });

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
      ['DYNAMIC_OCCLUSION_START', 'DYNAMIC_OCCLUSION_END'],
    );
    assert.equal(events[0]!.data.trigger_marker, 'T0');
    assert.equal(events[0]!.data.pedestrian_direction, 'H1_TO_H2');
    assert.throws(
      () =>
        manager.RecordEvent(created.experiment_id, {
          event: 'DYNAMIC_OCCLUSION_START',
          trigger_marker: 'T0',
          pedestrian_direction: 'H1_TO_H2',
        }),
      /already been recorded/,
    );
  } finally {
    Date.now = originalNow;
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
    const kidnapped = manager.Create({
      condition: 'nominal',
      run_type: 'kidnapped',
      trial: 1,
      route_id: 'KIDNAP_SAME_ROOM',
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
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
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
