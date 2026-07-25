import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnalyzeExperiment, AngleErrorDegrees, ReadJsonLines } from './experiment-analysis.js';

test('heading error uses the shortest angular distance across a 2π boundary', () => {
  assert.ok(AngleErrorDegrees(-5.124898433685303, 1.1745409965515137) < 1);
  assert.ok(AngleErrorDegrees(0, 2 * Math.PI) < 1e-12);
});

test('JSONL reader tolerates only an incomplete trailing recorder row', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-jsonl-test-'));
  try {
    const file = path.join(directory, 'telemetry.jsonl');
    fs.writeFileSync(file, '{"sequence":1}\n{"sequence":2');
    assert.deepEqual(ReadJsonLines<{ sequence: number }>(file), [{ sequence: 1 }]);

    fs.writeFileSync(file, '{"sequence":1\n{"sequence":2}\n');
    assert.throws(() => ReadJsonLines(file), SyntaxError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dynamic analysis emits one metrics row for each occluded marker', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-dynamic-analysis-'));
  try {
    for (const name of ['raw', 'processed', 'tables', 'plots'])
      fs.mkdirSync(path.join(directory, name));
    const markers = ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
    const events = markers.flatMap((marker, index) => {
      const started = 10_000 + index * 10_000;
      return [
        {
          timestamp_ms: started,
          event: 'DYNAMIC_OCCLUSION_START',
          data: { trigger_marker: marker, occluder_direction: 'LEFT_TO_RIGHT' },
        },
        {
          timestamp_ms: started + 4_000,
          event: 'DYNAMIC_OCCLUSION_END',
          data: { trigger_marker: marker, occluder_direction: 'LEFT_TO_RIGHT' },
        },
      ];
    });
    fs.writeFileSync(
      path.join(directory, 'raw', 'operator_events.jsonl'),
      `${events.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    const checkpoints = markers.map((marker, index) => ({
      timestamp_ms: 15_000 + index * 10_000,
      marker_id: marker,
      zone: 'room_1',
      reference: { x: index, y: index, yaw: 0 },
      estimate: { x: index + 0.01, y: index, yaw: 0.01, score: 0.8, valid: true },
    }));
    fs.writeFileSync(
      path.join(directory, 'raw', 'ground_truth.jsonl'),
      `${checkpoints.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    const telemetry = markers.flatMap((_, index) => {
      const started = 10_000 + index * 10_000;
      return [
        { timestamp: started - 900, left: 0, center: 0, right: 0 },
        { timestamp: started - 700, left: 0, center: 0, right: 0 },
        { timestamp: started - 500, left: 0, center: 0, right: 0 },
        { timestamp: started - 300, left: 0, center: 0, right: 0 },
        { timestamp: started - 100, left: 0, center: 0, right: 0 },
        { timestamp: started, left: 8, center: 0, right: 0 },
        { timestamp: started + 2_000, left: 0, center: 8, right: 0 },
        { timestamp: started + 4_000, left: 0, center: 0, right: 8 },
        { timestamp: started + 4_100, left: 0, center: 0, right: 0 },
      ].map((observation, sample) => ({
        schema: 'luckfox.localization.scan.v1',
        sequence: index * 9 + sample,
        timestamp_unix_ms: observation.timestamp,
        x_m: index,
        y_m: index,
        yaw_rad: 0,
        score: 0.7 + sample * 0.05,
        mode: 'tracking',
        state: 'TRACKING',
        accepted: true,
        candidate_count: 1,
        front_near_left_points: observation.left,
        front_near_center_points: observation.center,
        front_near_right_points: observation.right,
        front_minimum_range_m: 0.5,
        matcher_execution_us: 100,
        scan_cycle_us: 200,
        process_cpu_percent: 10,
        rss_kb: 1_000,
        peak_rss_kb: 1_100,
      }));
    });
    fs.writeFileSync(
      path.join(directory, 'raw', 'telemetry.jsonl'),
      `${telemetry.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const result = AnalyzeExperiment(directory, 'dynamic-test', 'dynamic_occluded') as {
      dynamic_occlusion: {
        event_count: number;
        completed_marker_count: number;
        valid_duration_count: number;
        object_detection_available_count: number;
        object_passing_detected_count: number;
        object_passing_detection_rate: number;
      };
    };
    assert.equal(result.dynamic_occlusion.event_count, 6);
    assert.equal(result.dynamic_occlusion.completed_marker_count, 6);
    assert.equal(result.dynamic_occlusion.valid_duration_count, 6);
    assert.equal(result.dynamic_occlusion.object_detection_available_count, 6);
    assert.equal(result.dynamic_occlusion.object_passing_detected_count, 6);
    assert.equal(result.dynamic_occlusion.object_passing_detection_rate, 1);
    assert.equal(
      fs
        .readFileSync(path.join(directory, 'tables', 'dynamic_occlusion.csv'), 'utf8')
        .trim()
        .split(/\r?\n/).length,
      7,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ablation analysis validates the complete 2x2 factorial replay', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-ablation-analysis-'));
  try {
    for (const name of ['raw', 'processed', 'tables', 'plots', 'config'])
      fs.mkdirSync(path.join(directory, name));
    const sourceRaw = path.join(directory, 'source-raw');
    fs.mkdirSync(sourceRaw);
    fs.writeFileSync(
      path.join(sourceRaw, 'ground_truth.jsonl'),
      `${JSON.stringify({
        timestamp_ms: 3_000,
        marker_id: 'M2',
        zone: 'room_1',
        reference: { x: 1, y: 2, yaw: 0 },
        estimate: { x: 1, y: 2, yaw: 0, score: 0.95, valid: true },
      })}\n`,
    );
    fs.writeFileSync(path.join(sourceRaw, 'operator_events.jsonl'), '');
    const variants = [
      ['local_only_single', false, false],
      ['local_only_multi', false, true],
      ['local_global_single', true, false],
      ['local_global_multi', true, true],
    ] as const;
    fs.writeFileSync(
      path.join(directory, 'config', 'ablation_source.json'),
      `${JSON.stringify({
        source_experiment_id: 'source-test',
        source_run_type: 'route',
        source_raw_scan: path.join(sourceRaw, 'raw_scans.csv'),
        source_raw_scan_sha256: 'a'.repeat(64),
        source_map_name: 'test-map',
        source_map_sha256: 'b'.repeat(64),
        initial_pose: { x: 1, y: 2, yaw: 0 },
        execution_target: 'host',
        replay_binary_sha256: 'c'.repeat(64),
        variants: variants.map(([variant]) => variant),
      })}\n`,
    );
    for (const [variant, globalRelocalization, multiResolution] of variants) {
      const rows = [1, 2, 3].map((sequence) => ({
        schema: 'luckfox.localization.replay.v1',
        variant,
        global_relocalization: globalRelocalization,
        multi_resolution: multiResolution,
        execution_target: 'host',
        sequence,
        timestamp_unix_ms: sequence * 1_000,
        scan_timestamp_ns: sequence * 1_000_000_000,
        x_m: 1,
        y_m: 2,
        yaw_rad: 0,
        score: 0.95,
        mode: 'tracking',
        state: 'TRACKING',
        accepted: true,
        candidate_count: multiResolution ? 100 : 200,
        matcher_execution_us: multiResolution ? 1_000 : 2_000,
      }));
      fs.writeFileSync(
        path.join(directory, 'raw', `replay_${variant}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
    }

    const result = AnalyzeExperiment(directory, 'ablation-test', 'ablation') as {
      protocol_valid: boolean;
      variants: Array<{ variant: string }>;
      factorial_comparisons: Record<string, unknown>;
    };
    assert.equal(result.protocol_valid, true);
    assert.deepEqual(
      result.variants.map((row) => row.variant),
      variants.map(([variant]) => variant),
    );
    assert.equal(Object.keys(result.factorial_comparisons).length, 4);
    assert.equal(
      fs
        .readFileSync(path.join(directory, 'tables', 'ablation.csv'), 'utf8')
        .trim()
        .split(/\r?\n/).length,
      5,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('board replay analysis validates only the selected production method', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-board-replay-analysis-'));
  try {
    for (const name of ['raw', 'processed', 'tables', 'plots', 'config'])
      fs.mkdirSync(path.join(directory, name));
    const sourceRaw = path.join(directory, 'source-raw');
    fs.mkdirSync(sourceRaw);
    fs.writeFileSync(
      path.join(sourceRaw, 'ground_truth.jsonl'),
      `${JSON.stringify({
        timestamp_ms: 3_000,
        marker_id: 'M2',
        zone: 'room_1',
        reference: { x: 1, y: 2, yaw: 0 },
        estimate: { x: 1, y: 2, yaw: 0, score: 0.95, valid: true },
      })}\n`,
    );
    fs.writeFileSync(path.join(sourceRaw, 'operator_events.jsonl'), '');
    fs.writeFileSync(
      path.join(directory, 'config', 'ablation_source.json'),
      `${JSON.stringify({
        source_experiment_id: 'source-test',
        source_run_type: 'route',
        source_raw_scan: path.join(sourceRaw, 'raw_scans.csv'),
        source_raw_scan_sha256: 'a'.repeat(64),
        source_map_name: 'test-map',
        source_map_sha256: 'b'.repeat(64),
        initial_pose: { x: 1, y: 2, yaw: 0 },
        execution_target: 'rv1103',
        replay_binary_sha256: 'c'.repeat(64),
        validation_mode: 'selected_method_board',
        variants: ['local_global_multi'],
      })}\n`,
    );
    const rows = [1, 2, 3].map((sequence) => ({
      schema: 'luckfox.localization.replay.v1',
      variant: 'local_global_multi',
      global_relocalization: true,
      multi_resolution: true,
      execution_target: 'rv1103',
      sequence,
      timestamp_unix_ms: sequence * 1_000,
      scan_timestamp_ns: sequence * 1_000_000_000,
      x_m: 1,
      y_m: 2,
      yaw_rad: 0,
      score: 0.95,
      mode: 'tracking',
      state: 'TRACKING',
      accepted: true,
      candidate_count: 100,
      matcher_execution_us: 1_000,
      scan_cycle_us: 1_010,
      process_cpu_percent: 90,
      peak_rss_kb: 1_500,
    }));
    fs.writeFileSync(
      path.join(directory, 'raw', 'replay_local_global_multi.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const result = AnalyzeExperiment(directory, 'board-replay-test', 'ablation') as {
      protocol_valid: boolean;
      validation_mode: string;
      variants: Array<{ variant: string }>;
      factorial_comparisons: null;
    };
    assert.equal(result.protocol_valid, true);
    assert.equal(result.validation_mode, 'selected_method_board');
    assert.deepEqual(
      result.variants.map((row) => row.variant),
      ['local_global_multi'],
    );
    assert.equal(result.factorial_comparisons, null);
    assert.equal(
      fs
        .readFileSync(path.join(directory, 'tables', 'ablation.csv'), 'utf8')
        .trim()
        .split(/\r?\n/).length,
      2,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Resource replay requires recorded pacing and writes board resource metrics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-resource-replay-analysis-'));
  try {
    for (const name of ['raw', 'processed', 'tables', 'plots', 'config'])
      fs.mkdirSync(path.join(directory, name));
    const sourceRaw = path.join(directory, 'source-raw');
    fs.mkdirSync(sourceRaw);
    fs.writeFileSync(path.join(sourceRaw, 'ground_truth.jsonl'), '');
    fs.writeFileSync(path.join(sourceRaw, 'operator_events.jsonl'), '');
    fs.writeFileSync(
      path.join(directory, 'config', 'ablation_source.json'),
      `${JSON.stringify({
        source_experiment_id: 'accepted-rv1103-route',
        source_run_type: 'route',
        source_raw_scan: path.join(sourceRaw, 'raw_scans.csv'),
        source_raw_scan_sha256: 'a'.repeat(64),
        source_map_name: 'test-map',
        source_map_sha256: 'b'.repeat(64),
        initial_pose: { x: 1, y: 2, yaw: 0 },
        execution_target: 'rv1103',
        replay_binary_sha256: 'c'.repeat(64),
        validation_mode: 'resource_replay_board',
        replay_pacing: 'recorded',
        variants: ['local_global_multi'],
      })}\n`,
    );
    const rows = [1, 2, 3].map((sequence) => ({
      schema: 'luckfox.localization.replay.v1',
      variant: 'local_global_multi',
      global_relocalization: true,
      multi_resolution: true,
      execution_target: 'rv1103',
      replay_pacing: 'recorded',
      sequence,
      timestamp_unix_ms: sequence * 1_000,
      scan_timestamp_ns: sequence * 1_000_000_000,
      x_m: 1,
      y_m: 2,
      yaw_rad: 0,
      score: 0.95,
      mode: sequence === 1 ? 'global' : 'tracking',
      state: 'TRACKING',
      accepted: true,
      candidate_count: 100,
      matcher_execution_us: sequence === 1 ? 125_000 : 20_000,
      scan_cycle_us: sequence === 1 ? 125_100 : 20_100,
      process_cpu_percent: 88,
      peak_rss_kb: 1_600,
    }));
    fs.writeFileSync(
      path.join(directory, 'raw', 'replay_local_global_multi.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const result = AnalyzeExperiment(directory, 'resource-replay-test', 'resource') as {
      schema: string;
      protocol_valid: boolean;
      replay_pacing: string;
      variants: Array<{ deadline_miss_count: number; global_scan_count: number }>;
    };
    assert.equal(result.schema, 'luckfox.experiment.resource-replay.v1');
    assert.equal(result.protocol_valid, true);
    assert.equal(result.replay_pacing, 'recorded');
    assert.equal(result.variants[0]?.deadline_miss_count, 1);
    assert.equal(result.variants[0]?.global_scan_count, 1);
    assert.equal(fs.existsSync(path.join(directory, 'tables', 'resource_replay.csv')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
