import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExperimentManager } from './experiments.js';

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
        path.join(outputRoot, created.experiment_id, 'raw', 'operator_events.jsonl'),
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
    });
    fs.writeFileSync(
      path.join(outputRoot, route.experiment_id, 'raw', 'raw_scans.csv'),
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
