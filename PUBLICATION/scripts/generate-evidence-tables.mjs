#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicationDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(publicationDir, '..');
const acceptedDir = path.join(repositoryDir, 'EXPERIMENTS', 'Accepted');
const outputDir = path.join(publicationDir, 'tables', 'generated');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const summaryFiles = walk(acceptedDir)
  .filter((file) => file.endsWith(`${path.sep}processed${path.sep}summary.json`))
  .sort();

const records = summaryFiles.map((summaryFile) => {
  const directory = path.dirname(path.dirname(summaryFile));
  const relative = path.relative(acceptedDir, directory).split(path.sep);
  const session = JSON.parse(
    fs.readFileSync(path.join(directory, 'config', 'session.json'), 'utf8'),
  );
  return {
    platform: relative[0],
    test: relative[1],
    experimentId: relative[2],
    directory,
    session,
    summary: JSON.parse(fs.readFileSync(summaryFile, 'utf8')),
  };
});

const markdownCell = (value) =>
  String(value ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const table = (headers, rows) =>
  [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
    '',
  ].join('\n');
const fixed = (value, digits = 3) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
const percent = (value, digits = 2) =>
  Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}` : '—';
const shortId = (value) => String(value).match(/T\d{6}Z/)?.[0] ?? String(value).slice(0, 12);
const conditionLabel = (value) =>
  ({
    nominal: 'Nominal',
    furniture_changed: 'Furniture changed',
    lidar_occluded_90: 'LiDAR occluded 90°',
    dynamic_occluded: 'Dynamic occlusion',
  })[value] ?? value;
const routeLabel = (value) =>
  ({
    R1_ROOM_1_TO_2: 'R1',
    R2_ROOM_2_TO_1: 'R2',
    KIDNAP_SAME_ROOM: 'Same room',
    KIDNAP_CROSS_ROOM: 'Cross room',
    GROUND_TRUTH_REPEAT: 'Repeated placement',
    ABLATION_REPLAY: 'Replay',
    RESOURCE_SEQUENCE: 'Resource',
  })[value] ?? value;

const furnitureRecords = records.filter(
  (record) => record.test === 'ROUTE' && record.session.condition === 'furniture_changed',
);
const furnitureSignedHeadingDeltas = furnitureRecords.flatMap(({ directory }) =>
  fs
    .readFileSync(path.join(directory, 'raw', 'ground_truth.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((row) =>
      Math.atan2(
        Math.sin(row.estimate.yaw - row.reference.yaw),
        Math.cos(row.estimate.yaw - row.reference.yaw),
      ),
    ),
);
const furnitureHeadingOffsetRad = Math.atan2(
  furnitureSignedHeadingDeltas.reduce((sum, value) => sum + Math.sin(value), 0),
  furnitureSignedHeadingDeltas.reduce((sum, value) => sum + Math.cos(value), 0),
);
const observedFurnitureHeadingOffset = (directory) => {
  const deltas = fs
    .readFileSync(path.join(directory, 'raw', 'ground_truth.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((row) =>
      Math.atan2(
        Math.sin(row.estimate.yaw - row.reference.yaw),
        Math.cos(row.estimate.yaw - row.reference.yaw),
      ),
    );
  return (
    (Math.atan2(
      deltas.reduce((sum, value) => sum + Math.sin(value), 0),
      deltas.reduce((sum, value) => sum + Math.cos(value), 0),
    ) *
      180) /
    Math.PI
  );
};
const correctedFurnitureHeading = (directory) => {
  const errors = fs
    .readFileSync(path.join(directory, 'raw', 'ground_truth.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((row) =>
      Math.abs(
        (Math.atan2(
          Math.sin(row.estimate.yaw - row.reference.yaw - furnitureHeadingOffsetRad),
          Math.cos(row.estimate.yaw - row.reference.yaw - furnitureHeadingOffsetRad),
        ) *
          180) /
          Math.PI,
      ),
    )
    .sort((left, right) => left - right);
  const percentileIndex = (errors.length - 1) * 0.95;
  const lower = Math.floor(percentileIndex);
  const upper = Math.ceil(percentileIndex);
  return {
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length),
    p95:
      lower === upper
        ? errors[lower]
        : errors[lower] * (upper - percentileIndex) +
          errors[upper] * (percentileIndex - lower),
  };
};

fs.mkdirSync(outputDir, { recursive: true });

const groundTruth = records.filter((record) => record.test === 'GROUND TRUTH');
fs.writeFileSync(
  path.join(outputDir, 'ground-truth-results.md'),
  table(
    [
      'Platform',
      'Experiment',
      'Placements',
      'Position RMSE (m)',
      'Position max (m)',
      'Heading RMSE (°)',
      'Heading max (°)',
    ],
    groundTruth.map(({ platform, experimentId, summary }) => [
      platform,
      shortId(experimentId),
      summary.ground_truth_repeatability?.placement_count,
      fixed(summary.accuracy?.position_error_m?.rmse, 6),
      fixed(summary.accuracy?.position_error_m?.maximum, 6),
      fixed(summary.accuracy?.heading_error_deg?.rmse),
      fixed(summary.accuracy?.heading_error_deg?.maximum),
    ]),
  ),
);

const routes = records.filter((record) => record.test === 'ROUTE');
fs.writeFileSync(
  path.join(outputDir, 'route-results.md'),
  table(
    [
      'Platform',
      'Condition',
      'Route',
      'Experiment',
      'Checkpoints',
      'Position RMSE / P95 (m)',
      'Heading RMSE / P95 (°)',
      'Success (%)',
    ],
    routes.map(({ platform, experimentId, directory, session, summary }) => {
      const corrected =
        session.condition === 'furniture_changed'
          ? correctedFurnitureHeading(directory)
          : undefined;
      return [
        platform,
        conditionLabel(session.condition),
        routeLabel(session.route_id),
        shortId(experimentId),
        summary.accuracy?.checkpoint_count,
        `${fixed(summary.accuracy?.position_error_m?.rmse)} / ${fixed(
          summary.accuracy?.position_error_m?.p95,
        )}`,
        corrected
          ? `${fixed(corrected.rmse)} / ${fixed(corrected.p95)}*`
          : `${fixed(summary.accuracy?.heading_error_deg?.rmse)} / ${fixed(
              summary.accuracy?.heading_error_deg?.p95,
            )}`,
        percent(summary.accuracy?.success_rate),
      ];
    }),
  ),
);

fs.writeFileSync(
  path.join(outputDir, 'furniture-heading-correction.md'),
  [
    `The documented constant reference-yaw correction is **${fixed(
      (furnitureHeadingOffsetRad * 180) / Math.PI,
    )}°** (added to the recorded reference yaw).`,
    '',
    table(
      [
        'Route',
        'Observed signed offset (°)',
        'Raw heading RMSE (°)',
        'Corrected RMSE (°)',
        'Corrected P95 (°)',
      ],
      furnitureRecords.map(({ directory, session, summary }) => {
        const corrected = correctedFurnitureHeading(directory);
        return [
          routeLabel(session.route_id),
          fixed(observedFurnitureHeadingOffset(directory)),
          fixed(summary.accuracy?.heading_error_deg?.rmse),
          fixed(corrected.rmse),
          fixed(corrected.p95),
        ];
      }),
    ),
  ].join('\n'),
);

const kidnapped = records.filter((record) => record.test === 'KIDNAPPED');
fs.writeFileSync(
  path.join(outputDir, 'kidnapped-results.md'),
  table(
    [
      'Platform',
      'Scenario',
      'Experiment',
      'Recovered / stable tracking (ms)',
      'Final position error (m)',
      'Final heading error (°)',
      'Success',
    ],
    kidnapped.map(({ platform, experimentId, session, summary }) => [
      platform,
      routeLabel(session.route_id),
      shortId(experimentId),
      `${fixed(summary.relocalization?.first_recovered_ms?.mean, 0)} / ${fixed(
        summary.relocalization?.stable_tracking_ms?.mean,
        0,
      )}`,
      fixed(summary.accuracy?.position_error_m?.rmse, 5),
      fixed(summary.accuracy?.heading_error_deg?.rmse),
      summary.relocalization?.success_rate === 1 ? 'Yes' : 'No',
    ]),
  ),
);

const dynamic = records.filter((record) => record.test === 'DYNAMIC OCCLUDED');
fs.writeFileSync(
  path.join(outputDir, 'dynamic-session-results.md'),
  table(
    [
      'Route',
      'Experiment',
      'Events',
      'Accepted rate mean (%)',
      'Post-event TRACKING mean / P95 (ms)',
      'Position RMSE (m)',
      'Heading RMSE (°)',
    ],
    dynamic.map(({ experimentId, session, summary }) => [
      routeLabel(session.route_id),
      shortId(experimentId),
      summary.dynamic_occlusion?.event_count,
      percent(summary.dynamic_occlusion?.accepted_scan_rate?.mean),
      `${fixed(summary.dynamic_occlusion?.recovery_tracking_ms?.mean, 1)} / ${fixed(
        summary.dynamic_occlusion?.recovery_tracking_ms?.p95,
        1,
      )}`,
      fixed(summary.accuracy?.position_error_m?.rmse),
      fixed(summary.accuracy?.heading_error_deg?.rmse),
    ]),
  ),
);

fs.writeFileSync(
  path.join(outputDir, 'dynamic-event-results.md'),
  table(
    [
      'Route',
      'Marker',
      'Scans',
      'Accepted (%)',
      'Minimum score',
      'Post-event TRACKING (ms)',
      'Max position drift (m)',
      'Near-sector excess L/C/R',
      'Min range (m)',
    ],
    dynamic.flatMap(({ session, summary }) =>
      (summary.dynamic_occlusion?.events ?? []).map((event) => [
        routeLabel(session.route_id),
        event.trigger_marker,
        event.scan_count,
        percent(event.accepted_scan_rate),
        fixed(event.score_minimum),
        fixed(event.recovery_tracking_ms, 0),
        fixed(event.maximum_position_drift_m),
        `${fixed(event.object_passing?.left_excess_points, 1)}/${fixed(
          event.object_passing?.center_excess_points,
          1,
        )}/${fixed(event.object_passing?.right_excess_points, 1)}`,
        fixed(event.object_passing?.minimum_front_range_m),
      ]),
    ),
  ),
);

const ablations = records.filter((record) => record.test === 'ABLATION');
fs.writeFileSync(
  path.join(outputDir, 'ablation-results.md'),
  table(
    [
      'Target',
      'Source',
      'Variant',
      'Scans',
      'Accepted (%)',
      'Success',
      'Matcher mean / P95 (ms)',
      'CPU mean (%)',
      'Peak RSS (KiB)',
      'Recovery (ms)',
    ],
    ablations.flatMap(({ summary }) =>
      (summary.variants ?? []).map((variant) => [
        summary.execution_target,
        shortId(summary.source_experiment_id),
        variant.variant,
        variant.scans,
        percent(variant.accepted_scan_rate),
        variant.success ? 'Yes' : 'No',
        `${fixed(variant.execution_time_ms?.mean)} / ${fixed(
          variant.execution_time_ms?.p95,
        )}`,
        fixed(variant.cpu_percent?.mean, 2),
        variant.peak_rss_kb,
        fixed(variant.recovery_time_ms, 0),
      ]),
    ),
  ),
);

fs.writeFileSync(
  path.join(outputDir, 'accepted-inventory.md'),
  table(
    ['Platform', 'Test', 'Experiment ID', 'Condition', 'Scenario', 'State'],
    records.map(({ platform, test, experimentId, session }) => [
      platform,
      test,
      experimentId,
      conditionLabel(session.condition),
      routeLabel(session.route_id),
      session.state,
    ]),
  ),
);

console.log(`Wrote ${records.length} Accepted-session records to ${outputDir}`);
