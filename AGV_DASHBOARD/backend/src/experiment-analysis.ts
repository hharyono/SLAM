import fs from 'node:fs';
import path from 'node:path';

type NumericSummary = {
  n: number;
  minimum?: number;
  mean?: number;
  median?: number;
  rmse?: number;
  standard_deviation?: number;
  p95?: number;
  maximum?: number;
  confidence_interval_95_lower?: number;
  confidence_interval_95_upper?: number;
};

type TelemetryRow = {
  schema?: string;
  sequence: number;
  timestamp_unix_ms: number;
  scan_timestamp_ns?: number;
  x_m: number;
  y_m: number;
  yaw_rad: number;
  score: number;
  mode: 'global' | 'tracking';
  state: string;
  accepted: boolean;
  candidate_count: number;
  front_near_left_points?: number;
  front_near_center_points?: number;
  front_near_right_points?: number;
  front_minimum_range_m?: number | null;
  matcher_execution_us: number;
  scan_cycle_us: number;
  process_cpu_percent: number;
  process_cpu_delta_us?: number;
  process_cpu_interval_delta_us?: number;
  process_cpu_interval_percent?: number;
  replay_interval_us?: number;
  pacing_wait_us?: number;
  rss_kb: number;
  peak_rss_kb: number;
};

type CheckpointRow = {
  timestamp_ms: number;
  marker_id: string;
  zone: string;
  reference: { x: number; y: number; yaw: number };
  estimate: { x: number; y: number; yaw: number; score: number; valid: boolean };
};

type EventRow = {
  timestamp_ms: number;
  event: string;
  reference?: { x: number; y: number; yaw: number; marker_id?: string };
  data?: {
    trigger_marker?: string;
    occluder_direction?: string;
    obstacle_width_cm?: number;
    obstacle_depth_cm?: number;
    obstacle_height_cm?: number;
    obstacle_distance_from_lidar_cm?: number;
    repetition?: number;
  };
  notes?: string;
};

type ResourceRow = {
  schema: 'luckfox.localization.resource.v1';
  timestamp_unix_ms: number;
  operating_state: string;
  process_cpu_percent: number;
  rss_kb: number;
  peak_rss_kb: number;
};

type ReplayRow = TelemetryRow & {
  variant: string;
  global_relocalization: boolean;
  multi_resolution: boolean;
  execution_target: 'host' | 'rv1103' | 'rv1106';
  replay_pacing?: 'unpaced' | 'recorded';
};

type ObstacleSectorKey =
  'front_near_left_points' | 'front_near_center_points' | 'front_near_right_points';

export function ReadJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as T];
    } catch (error) {
      // A recorder can be stopped between two writes. Preserve the raw evidence,
      // but do not let one incomplete trailing row invalidate the whole analysis.
      if (index === lines.length - 1) return [];
      throw error;
    }
  });
}

function Percentile(values: number[], percent: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = ((ordered.length - 1) * percent) / 100;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! * (upper - index) + ordered[upper]! * (index - lower);
}

function Summarize(values: number[]): NumericSummary {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0 };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const ordered = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
  return {
    n: finite.length,
    minimum: Math.min(...finite),
    mean,
    median,
    rmse: Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length),
    standard_deviation: Math.sqrt(
      finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length,
    ),
    p95: Percentile(finite, 95),
    maximum: Math.max(...finite),
    confidence_interval_95_lower:
      mean -
      (finite.length > 1
        ? (1.96 *
            Math.sqrt(
              finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1),
            )) /
          Math.sqrt(finite.length)
        : 0),
    confidence_interval_95_upper:
      mean +
      (finite.length > 1
        ? (1.96 *
            Math.sqrt(
              finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1),
            )) /
          Math.sqrt(finite.length)
        : 0),
  };
}

function SummaryValues(summary: NumericSummary): unknown[] {
  return [
    summary.n,
    summary.mean,
    summary.median,
    summary.rmse,
    summary.standard_deviation,
    summary.p95,
    summary.maximum,
    summary.confidence_interval_95_lower,
    summary.confidence_interval_95_upper,
  ];
}

function DetectObjectPassing(
  telemetry: TelemetryRow[],
  startedUnixMs: number,
  endedUnixMs: number,
): {
  available: boolean;
  detected: boolean;
  observed_direction: 'LEFT_TO_RIGHT' | 'RIGHT_TO_LEFT' | 'UNRESOLVED';
  baseline_scan_count: number;
  left_excess_points: number | null;
  center_excess_points: number | null;
  right_excess_points: number | null;
  minimum_front_range_m: number | null;
} {
  const baseline = telemetry.filter(
    (row) =>
      row.timestamp_unix_ms >= startedUnixMs - 1_000 && row.timestamp_unix_ms < startedUnixMs,
  );
  const during = telemetry.filter(
    (row) => row.timestamp_unix_ms >= startedUnixMs && row.timestamp_unix_ms <= endedUnixMs,
  );
  const keys: ObstacleSectorKey[] = [
    'front_near_left_points',
    'front_near_center_points',
    'front_near_right_points',
  ];
  const baselineWithSignature = baseline.filter((row) =>
    keys.every((key) => Number.isFinite(row[key])),
  );
  const available =
    baselineWithSignature.length >= 5 &&
    during.some((row) => keys.every((key) => Number.isFinite(row[key])));
  if (!available)
    return {
      available: false,
      detected: false,
      observed_direction: 'UNRESOLVED',
      baseline_scan_count: baselineWithSignature.length,
      left_excess_points: null,
      center_excess_points: null,
      right_excess_points: null,
      minimum_front_range_m: null,
    };

  const sectors = keys.map((key) => {
    const baselineValues = baselineWithSignature
      .map((row) => Number(row[key]))
      .filter(Number.isFinite);
    const baselineMedian = baselineValues.length ? Percentile(baselineValues, 50) : 0;
    const peak = during.reduce(
      (best, row) => {
        const value = Number(row[key]);
        return Number.isFinite(value) && value > best.value
          ? { value, timestamp: row.timestamp_unix_ms }
          : best;
      },
      { value: 0, timestamp: startedUnixMs },
    );
    return {
      excess: Math.max(0, peak.value - baselineMedian),
      peak_timestamp_ms: peak.timestamp,
    };
  });
  const [left, center, right] = sectors;
  const leftToRight =
    left!.peak_timestamp_ms < center!.peak_timestamp_ms &&
    center!.peak_timestamp_ms < right!.peak_timestamp_ms;
  const rightToLeft =
    right!.peak_timestamp_ms < center!.peak_timestamp_ms &&
    center!.peak_timestamp_ms < left!.peak_timestamp_ms;
  const detected =
    left!.excess >= 3 && center!.excess >= 3 && right!.excess >= 3 && (leftToRight || rightToLeft);
  const ranges = during
    .map((row) => Number(row.front_minimum_range_m))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    available: true,
    detected,
    observed_direction: leftToRight
      ? 'LEFT_TO_RIGHT'
      : rightToLeft
        ? 'RIGHT_TO_LEFT'
        : 'UNRESOLVED',
    baseline_scan_count: baselineWithSignature.length,
    left_excess_points: left!.excess,
    center_excess_points: center!.excess,
    right_excess_points: right!.excess,
    minimum_front_range_m: ranges.length ? Math.min(...ranges) : null,
  };
}

export function AngleErrorDegrees(estimate: number, reference: number): number {
  const delta = estimate - reference;
  const wrapped = Math.atan2(Math.sin(delta), Math.cos(delta));
  return (Math.abs(wrapped) * 180) / Math.PI;
}

function CsvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function WriteCsv(file: string, headers: string[], rows: unknown[][]): void {
  const output = [headers, ...rows].map((row) => row.map(CsvCell).join(',')).join('\n');
  fs.writeFileSync(file, `${output}\n`, { flag: 'wx' });
}

function EscapeXml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function WriteCheckpointSvg(
  file: string,
  experimentId: string,
  checkpoints: CheckpointRow[],
): void {
  const points = checkpoints.flatMap((row) => [
    [row.reference.x, row.reference.y] as const,
    [row.estimate.x, row.estimate.y] as const,
  ]);
  if (!points.length) return;
  const width = 900;
  const height = 620;
  const margin = 55;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 0.1);
  const spanY = Math.max(maxY - minY, 0.1);
  const Project = ([x, y]: readonly [number, number]): string => {
    const px = margin + ((x - minX) / spanX) * (width - margin * 2);
    const py = height - margin - ((y - minY) / spanY) * (height - margin * 2);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  };
  const pairs = checkpoints
    .map((row) => {
      const [truthX, truthY] = Project([row.reference.x, row.reference.y]).split(',');
      const [estimateX, estimateY] = Project([row.estimate.x, row.estimate.y]).split(',');
      return `<line x1="${truthX}" y1="${truthY}" x2="${estimateX}" y2="${estimateY}" stroke="#94a3b8"/><circle cx="${truthX}" cy="${truthY}" r="5" fill="#16a34a"/><circle cx="${estimateX}" cy="${estimateY}" r="4" fill="#2563eb"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
<text x="${margin}" y="28" font-family="sans-serif" font-size="17">Checkpoint localization comparison — ${EscapeXml(experimentId)}</text>
<rect x="${margin}" y="${margin}" width="${width - margin * 2}" height="${height - margin * 2}" fill="none" stroke="#94a3b8"/>
${pairs}
<text x="${margin}" y="${height - 15}" font-family="sans-serif" font-size="14">Independent checkpoints: ground truth (green), estimate (blue), units: metre</text>
</svg>
`;
  fs.writeFileSync(file, svg, { flag: 'wx' });
}

function WriteTimelineSvg(file: string, experimentId: string, telemetry: TelemetryRow[]): void {
  if (!telemetry.length) return;
  const colors: Record<string, string> = {
    GLOBAL_SEARCH: '#7c3aed',
    TRACKING: '#16a34a',
    DEGRADED: '#f59e0b',
    LOST: '#dc2626',
    RECOVERED: '#0284c7',
  };
  const width = 1000;
  const height = 190;
  const margin = 45;
  const plotWidth = width - margin * 2;
  const bars = telemetry
    .map((row, index) => {
      const x = margin + (index / telemetry.length) * plotWidth;
      const barWidth = Math.max(1, plotWidth / telemetry.length + 0.2);
      return `<rect x="${x.toFixed(2)}" y="58" width="${barWidth.toFixed(2)}" height="58" fill="${colors[row.state] ?? '#64748b'}"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
<text x="${margin}" y="28" font-family="sans-serif" font-size="17">Localization states — ${EscapeXml(experimentId)}</text>
${bars}
<text x="${margin}" y="150" font-family="sans-serif" font-size="13">GLOBAL_SEARCH purple · TRACKING green · DEGRADED orange · LOST red · RECOVERED blue</text>
<text x="${margin}" y="174" font-family="sans-serif" font-size="13">Scan sequence →</text>
</svg>
`;
  fs.writeFileSync(file, svg, { flag: 'wx' });
}

function WriteErrorSvg(
  file: string,
  experimentId: string,
  positionErrors: number[],
  headingErrors: number[],
): void {
  if (!positionErrors.length) return;
  const width = 900;
  const height = 520;
  const margin = 60;
  const barWidth = Math.max(8, (width - margin * 2) / positionErrors.length - 4);
  const maximum = Math.max(...positionErrors, 0.01);
  const bars = positionErrors
    .map((value, index) => {
      const x = margin + index * (barWidth + 4);
      const barHeight = (value / maximum) * (height - margin * 2);
      return `<rect x="${x.toFixed(2)}" y="${(height - margin - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="#2563eb"><title>position=${value.toFixed(4)} m, heading=${(headingErrors[index] ?? 0).toFixed(2)} deg</title></rect>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
<text x="${margin}" y="28" font-family="sans-serif" font-size="17">Checkpoint position error — ${EscapeXml(experimentId)}</text>
<line x1="${margin}" y1="${height - margin}" x2="${width - margin}" y2="${height - margin}" stroke="#334155"/>
<line x1="${margin}" y1="${margin}" x2="${margin}" y2="${height - margin}" stroke="#334155"/>
${bars}
<text x="${margin}" y="${height - 18}" font-family="sans-serif" font-size="13">Checkpoint index; bar unit: metre</text>
</svg>
`;
  fs.writeFileSync(file, svg, { flag: 'wx' });
}

function AnalyzeAblation(directory: string, experimentId: string): unknown {
  const raw = path.join(directory, 'raw');
  const processed = path.join(directory, 'processed');
  const tables = path.join(directory, 'tables');
  const summaryFile = path.join(processed, 'summary.json');
  if (fs.existsSync(summaryFile))
    throw new Error('Analysis output already exists; raw data will not be analyzed again');
  const sourceConfig = JSON.parse(
    fs.readFileSync(path.join(directory, 'config', 'ablation_source.json'), 'utf8'),
  ) as {
    source_experiment_id: string;
    source_run_type: string;
    source_raw_scan: string;
    source_raw_scan_sha256: string;
    source_map_name: string;
    source_map_sha256: string;
    initial_pose: { x: number; y: number; yaw: number };
    execution_target: 'host' | 'rv1103' | 'rv1106';
    replay_binary_sha256: string;
    validation_mode?: 'factorial_ablation' | 'selected_method_board' | 'resource_replay_board';
    replay_pacing?: 'unpaced' | 'recorded';
    variants: string[];
  };
  const sourceRawDirectory = path.dirname(sourceConfig.source_raw_scan);
  const checkpoints = ReadJsonLines<CheckpointRow>(
    path.join(sourceRawDirectory, 'ground_truth.jsonl'),
  );
  const events = ReadJsonLines<EventRow>(path.join(sourceRawDirectory, 'operator_events.jsonl'));
  const releaseReference = [...events]
    .reverse()
    .find((row) => row.event === 'KIDNAP_RELEASE')?.reference;
  const checkpointReference = checkpoints.at(-1)?.reference;
  const reference = releaseReference || checkpointReference;
  const releaseTimestampMs =
    sourceConfig.source_run_type === 'kidnapped'
      ? [...events].reverse().find((row) => row.event === 'KIDNAP_RELEASE')?.timestamp_ms
      : undefined;
  const factorialVariants = [
    'local_only_single',
    'local_only_multi',
    'local_global_single',
    'local_global_multi',
  ];
  const variants =
    sourceConfig.execution_target === 'host' ? factorialVariants : ['local_global_multi'];
  const resourceReplay = sourceConfig.validation_mode === 'resource_replay_board';
  const validationMode = resourceReplay
    ? 'resource_replay_board'
    : sourceConfig.execution_target === 'host'
      ? 'factorial_ablation'
      : 'selected_method_board';
  const expectedConfiguration = new Map([
    ['local_only_single', { global: false, multi: false }],
    ['local_only_multi', { global: false, multi: true }],
    ['local_global_single', { global: true, multi: false }],
    ['local_global_multi', { global: true, multi: true }],
  ]);
  let expectedScanSignature: string | undefined;
  const validityErrors: string[] = [];
  const rows = variants.map((variant) => {
    const replay = ReadJsonLines<ReplayRow>(path.join(raw, `replay_${variant}.jsonl`));
    if (!replay.length) throw new Error(`Replay output is empty for ${variant}`);
    const configuration = expectedConfiguration.get(variant)!;
    if (
      replay.some(
        (row) =>
          row.variant !== variant ||
          row.global_relocalization !== configuration.global ||
          row.multi_resolution !== configuration.multi ||
          row.execution_target !== sourceConfig.execution_target ||
          (resourceReplay && row.replay_pacing !== 'recorded'),
      )
    )
      validityErrors.push(`${variant} contains inconsistent configuration metadata`);
    const scanSignature = replay
      .map((row) => `${row.sequence}:${row.scan_timestamp_ns ?? ''}`)
      .join('|');
    if (expectedScanSignature === undefined) expectedScanSignature = scanSignature;
    else if (scanSignature !== expectedScanSignature)
      validityErrors.push(`${variant} did not replay the identical scan sequence and timestamps`);
    const evaluationStartMs = releaseTimestampMs ?? replay[0]!.timestamp_unix_ms;
    const evaluated = replay.filter((row) => row.timestamp_unix_ms >= evaluationStartMs);
    const precedingLoss = releaseTimestampMs
      ? [...replay]
          .reverse()
          .find(
            (row) =>
              row.timestamp_unix_ms <= releaseTimestampMs &&
              row.timestamp_unix_ms >= releaseTimestampMs - 5_000 &&
              (row.state === 'LOST' || row.state === 'GLOBAL_SEARCH'),
          )
      : undefined;
    const lostIndex = evaluated.findIndex(
      (row) => row.state === 'LOST' || row.state === 'GLOBAL_SEARCH',
    );
    const recoveryWindow = precedingLoss
      ? evaluated
      : lostIndex >= 0
        ? evaluated.slice(lostIndex + 1)
        : [];
    const recovered = recoveryWindow.find((row) => row.state === 'TRACKING' && row.accepted);
    const globalCandidate = recoveryWindow.find((row) => row.mode === 'global' && row.accepted);
    const accepted = replay.filter((row) => row.accepted);
    const trackingReplay = replay.filter((row) => row.mode === 'tracking');
    const globalReplay = replay.filter((row) => row.mode === 'global');
    const deadlineMissCount = replay.filter((row) => row.scan_cycle_us > 100_000).length;
    const pacedCpuRows = replay.filter(
      (row) =>
        Number.isFinite(row.process_cpu_interval_delta_us) &&
        Number.isFinite(row.replay_interval_us) &&
        Number(row.replay_interval_us) > 0,
    );
    const pacedCpuTimeUs = pacedCpuRows.reduce(
      (sum, row) => sum + Number(row.process_cpu_interval_delta_us),
      0,
    );
    const pacedWallTimeUs = pacedCpuRows.reduce(
      (sum, row) => sum + Number(row.replay_interval_us),
      0,
    );
    const requiredResourceFields: Array<keyof ReplayRow> = [
      'matcher_execution_us',
      'scan_cycle_us',
      'process_cpu_percent',
      'rss_kb',
      'peak_rss_kb',
    ];
    const resourceCompleteRows = replay.filter((row) =>
      requiredResourceFields.every((field) => Number.isFinite(Number(row[field]))),
    );
    if (resourceReplay && resourceCompleteRows.length !== replay.length)
      validityErrors.push(
        `${variant} has ${replay.length - resourceCompleteRows.length} rows with incomplete CPU/RSS/latency telemetry`,
      );
    if (resourceReplay && pacedCpuRows.length !== replay.length)
      validityErrors.push(
        `${variant} has ${replay.length - pacedCpuRows.length} rows without end-to-end paced CPU telemetry`,
      );
    const rejectedCount = replay.length - accepted.length;
    const finalAccepted = [...evaluated].reverse().find((row) => row.accepted);
    let recoveryPending = false;
    let falseRecoveryCount = 0;
    for (const row of evaluated) {
      if (row.state === 'RECOVERED') recoveryPending = true;
      if (recoveryPending && row.state === 'TRACKING') recoveryPending = false;
      if (recoveryPending && row.state === 'LOST') {
        ++falseRecoveryCount;
        recoveryPending = false;
      }
    }
    if (recoveryPending) ++falseRecoveryCount;
    return {
      variant,
      global_relocalization: configuration.global,
      multi_resolution: configuration.multi,
      execution_target: sourceConfig.execution_target,
      scans: replay.length,
      accepted_scans: accepted.length,
      rejected_scans: rejectedCount,
      accepted_scan_rate: accepted.length / replay.length,
      rejected_scan_rate: rejectedCount / replay.length,
      success:
        sourceConfig.source_run_type === 'kidnapped'
          ? Boolean(recovered)
          : Boolean(finalAccepted && finalAccepted.state === 'TRACKING'),
      success_rate:
        sourceConfig.source_run_type === 'kidnapped'
          ? recovered
            ? 1
            : 0
          : finalAccepted?.state === 'TRACKING'
            ? 1
            : 0,
      execution_time_ms: Summarize(replay.map((row) => row.matcher_execution_us / 1000)),
      scan_cycle_time_ms: Summarize(replay.map((row) => row.scan_cycle_us / 1000)),
      tracking_execution_time_ms: Summarize(
        trackingReplay.map((row) => row.matcher_execution_us / 1000),
      ),
      global_execution_time_ms: Summarize(
        globalReplay.map((row) => row.matcher_execution_us / 1000),
      ),
      global_scan_count: globalReplay.length,
      deadline_miss_count: deadlineMissCount,
      deadline_miss_rate: deadlineMissCount / replay.length,
      resource_telemetry_complete: resourceCompleteRows.length === replay.length,
      resource_telemetry_samples: resourceCompleteRows.length,
      cpu_percent: Summarize(
        resourceReplay
          ? replay.map((row) => Number(row.process_cpu_interval_percent))
          : replay.map((row) => row.process_cpu_percent),
      ),
      cpu_utilization_percent:
        pacedWallTimeUs > 0 ? (100 * pacedCpuTimeUs) / pacedWallTimeUs : undefined,
      matcher_cpu_percent: Summarize(replay.map((row) => row.process_cpu_percent)),
      cpu_time_us_total: pacedCpuRows.length ? pacedCpuTimeUs : undefined,
      replay_wall_time_us_total: pacedCpuRows.length ? pacedWallTimeUs : undefined,
      pacing_wait_ms: Summarize(replay.map((row) => Number(row.pacing_wait_us) / 1000)),
      rss_kb: Summarize(replay.map((row) => Number(row.rss_kb))),
      peak_rss_kb: Math.max(0, ...replay.map((row) => Number(row.peak_rss_kb) || 0)),
      candidate_count: Summarize(replay.map((row) => row.candidate_count)),
      global_candidate_acquisition_ms:
        releaseTimestampMs && globalCandidate
          ? globalCandidate.timestamp_unix_ms - evaluationStartMs
          : undefined,
      recovery_time_ms:
        releaseTimestampMs && recovered
          ? recovered.timestamp_unix_ms - evaluationStartMs
          : undefined,
      final_position_error_m:
        finalAccepted && reference
          ? Math.hypot(finalAccepted.x_m - reference.x, finalAccepted.y_m - reference.y)
          : undefined,
      final_heading_error_deg:
        finalAccepted && reference
          ? AngleErrorDegrees(finalAccepted.yaw_rad, reference.yaw)
          : undefined,
      false_recovery_count: falseRecoveryCount,
    };
  });
  if (sourceConfig.variants.join('|') !== variants.join('|'))
    validityErrors.push(
      sourceConfig.execution_target === 'host'
        ? 'orchestrator variant manifest does not match the required 2x2 design'
        : 'board validation must replay only the selected local_global_multi method',
    );
  if (sourceConfig.validation_mode && sourceConfig.validation_mode !== validationMode)
    validityErrors.push('replay validation mode does not match its execution target');
  if (new Set(rows.map((row) => row.scans)).size !== 1)
    validityErrors.push('replay scan counts differ between variants');
  const byVariant = Object.fromEntries(rows.map((row) => [row.variant, row]));
  const delta = (left: string, right: string, metric: 'success_rate' | 'recovery_time_ms') => {
    const leftValue = byVariant[left]![metric];
    const rightValue = byVariant[right]![metric];
    return typeof leftValue === 'number' && typeof rightValue === 'number'
      ? rightValue - leftValue
      : null;
  };
  const comparisons =
    sourceConfig.execution_target === 'host'
      ? {
          multi_resolution_effect_local_only: {
            success_rate_delta: delta('local_only_single', 'local_only_multi', 'success_rate'),
            recovery_time_delta_ms: delta(
              'local_only_single',
              'local_only_multi',
              'recovery_time_ms',
            ),
          },
          multi_resolution_effect_local_global: {
            success_rate_delta: delta('local_global_single', 'local_global_multi', 'success_rate'),
            recovery_time_delta_ms: delta(
              'local_global_single',
              'local_global_multi',
              'recovery_time_ms',
            ),
          },
          global_relocalization_effect_single: {
            success_rate_delta: delta('local_only_single', 'local_global_single', 'success_rate'),
            recovery_time_delta_ms: delta(
              'local_only_single',
              'local_global_single',
              'recovery_time_ms',
            ),
          },
          global_relocalization_effect_multi: {
            success_rate_delta: delta('local_only_multi', 'local_global_multi', 'success_rate'),
            recovery_time_delta_ms: delta(
              'local_only_multi',
              'local_global_multi',
              'recovery_time_ms',
            ),
          },
        }
      : null;
  WriteCsv(
    path.join(tables, resourceReplay ? 'resource_replay.csv' : 'ablation.csv'),
    [
      'variant',
      'global_relocalization',
      'multi_resolution',
      'execution_target',
      'scans',
      'accepted_scans',
      'rejected_scans',
      'accepted_scan_rate',
      'rejected_scan_rate',
      'success',
      'success_rate',
      'execution_time_mean_ms',
      'execution_time_p95_ms',
      'scan_cycle_mean_ms',
      'tracking_time_mean_ms',
      'tracking_time_p95_ms',
      'tracking_time_maximum_ms',
      'global_scan_count',
      'global_time_mean_ms',
      'global_time_maximum_ms',
      'deadline_miss_count',
      'deadline_miss_rate',
      'resource_telemetry_complete',
      'resource_telemetry_samples',
      'cpu_mean_percent',
      'cpu_p95_percent',
      'cpu_maximum_percent',
      'cpu_utilization_percent',
      'matcher_cpu_mean_percent',
      'matcher_cpu_p95_percent',
      'cpu_time_us_total',
      'replay_wall_time_us_total',
      'pacing_wait_mean_ms',
      'pacing_wait_p95_ms',
      'rss_mean_kb',
      'rss_p95_kb',
      'peak_rss_kb',
      'candidate_count_mean',
      'candidate_count_p95',
      'global_candidate_acquisition_ms',
      'recovery_time_ms',
      'final_position_error_m',
      'final_heading_error_deg',
      'false_recovery_count',
    ],
    rows.map((row) => [
      row.variant,
      row.global_relocalization,
      row.multi_resolution,
      row.execution_target,
      row.scans,
      row.accepted_scans,
      row.rejected_scans,
      row.accepted_scan_rate,
      row.rejected_scan_rate,
      row.success,
      row.success_rate,
      row.execution_time_ms.mean,
      row.execution_time_ms.p95,
      row.scan_cycle_time_ms.mean,
      row.tracking_execution_time_ms.mean,
      row.tracking_execution_time_ms.p95,
      row.tracking_execution_time_ms.maximum,
      row.global_scan_count,
      row.global_execution_time_ms.mean,
      row.global_execution_time_ms.maximum,
      row.deadline_miss_count,
      row.deadline_miss_rate,
      row.resource_telemetry_complete,
      row.resource_telemetry_samples,
      row.cpu_percent.mean,
      row.cpu_percent.p95,
      row.cpu_percent.maximum,
      row.cpu_utilization_percent,
      row.matcher_cpu_percent.mean,
      row.matcher_cpu_percent.p95,
      row.cpu_time_us_total,
      row.replay_wall_time_us_total,
      row.pacing_wait_ms.mean,
      row.pacing_wait_ms.p95,
      row.rss_kb.mean,
      row.rss_kb.p95,
      row.peak_rss_kb,
      row.candidate_count.mean,
      row.candidate_count.p95,
      row.global_candidate_acquisition_ms,
      row.recovery_time_ms,
      row.final_position_error_m,
      row.final_heading_error_deg,
      row.false_recovery_count,
    ]),
  );
  const summary = {
    schema: resourceReplay
      ? 'luckfox.experiment.resource-replay.v1'
      : 'luckfox.experiment.ablation.v1',
    experiment_id: experimentId,
    source_experiment_id: sourceConfig.source_experiment_id,
    source_raw_scan_sha256: sourceConfig.source_raw_scan_sha256,
    source_map_name: sourceConfig.source_map_name,
    source_map_sha256: sourceConfig.source_map_sha256,
    replay_binary_sha256: sourceConfig.replay_binary_sha256,
    initial_pose: sourceConfig.initial_pose,
    execution_target: sourceConfig.execution_target,
    validation_mode: validationMode,
    replay_pacing: sourceConfig.replay_pacing || 'unpaced',
    generated_unix_ms: Date.now(),
    protocol_valid: validityErrors.length === 0,
    validity_errors: validityErrors,
    variants: rows,
    factorial_comparisons: comparisons,
  };
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(
    path.join(processed, 'trial_report.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { flag: 'wx' },
  );
  return summary;
}

export function AnalyzeExperiment(
  directory: string,
  experimentId: string,
  runType: string,
): unknown {
  if (
    runType === 'ablation' ||
    (runType === 'resource' &&
      fs.existsSync(path.join(directory, 'config', 'ablation_source.json')))
  )
    return AnalyzeAblation(directory, experimentId);
  const raw = path.join(directory, 'raw');
  const processed = path.join(directory, 'processed');
  const tables = path.join(directory, 'tables');
  const plots = path.join(directory, 'plots');
  const summaryFile = path.join(processed, 'summary.json');
  if (fs.existsSync(summaryFile))
    throw new Error('Analysis output already exists; raw data will not be analyzed again');

  const telemetryFile = path.join(raw, 'telemetry.jsonl');
  const telemetry = ReadJsonLines<TelemetryRow>(telemetryFile).filter(
    (row) => row.schema === 'luckfox.localization.scan.v1',
  );
  const idleResources = ReadJsonLines<ResourceRow>(telemetryFile).filter(
    (row) => row.schema === 'luckfox.localization.resource.v1',
  );
  if (!telemetry.length) throw new Error('Scan telemetry is unavailable or empty');
  const checkpoints = ReadJsonLines<CheckpointRow>(path.join(raw, 'ground_truth.jsonl'));
  const events = ReadJsonLines<EventRow>(path.join(raw, 'operator_events.jsonl'));

  const dynamicStarts = events.filter((row) => row.event === 'DYNAMIC_OCCLUSION_START');
  const dynamicEnds = events.filter((row) => row.event === 'DYNAMIC_OCCLUSION_END');
  const dynamicEvents = dynamicStarts.flatMap((start) => {
    const markerId = start.data?.trigger_marker;
    const end = dynamicEnds.find((candidate) => candidate.data?.trigger_marker === markerId);
    if (!markerId || !end) return [];
    const during = telemetry.filter(
      (row) =>
        row.timestamp_unix_ms >= start.timestamp_ms && row.timestamp_unix_ms <= end.timestamp_ms,
    );
    const recovered = telemetry.find(
      (row) =>
        row.timestamp_unix_ms >= end.timestamp_ms &&
        row.accepted &&
        row.state.toUpperCase() === 'TRACKING',
    );
    const checkpoint = checkpoints.find((row) => row.marker_id === markerId);
    const scores = during.map((row) => row.score).filter(Number.isFinite);
    const objectPassing = DetectObjectPassing(telemetry, start.timestamp_ms, end.timestamp_ms);
    const firstPose = during[0];
    const maximumPositionDriftM = firstPose
      ? Math.max(
          ...during.map((row) => Math.hypot(row.x_m - firstPose.x_m, row.y_m - firstPose.y_m)),
        )
      : null;
    const maximumHeadingDriftDeg = firstPose
      ? Math.max(...during.map((row) => AngleErrorDegrees(row.yaw_rad, firstPose.yaw_rad)))
      : null;
    return [
      {
        trigger_marker: markerId,
        occluder_direction: start.data?.occluder_direction,
        started_unix_ms: start.timestamp_ms,
        ended_unix_ms: end.timestamp_ms,
        duration_ms: end.timestamp_ms - start.timestamp_ms,
        duration_valid:
          end.timestamp_ms - start.timestamp_ms >= 3_500 &&
          end.timestamp_ms - start.timestamp_ms <= 4_500,
        scan_count: during.length,
        accepted_scan_rate: during.length
          ? during.filter((row) => row.accepted).length / during.length
          : null,
        score_minimum: scores.length ? Math.min(...scores) : null,
        localization_score: Summarize(scores),
        degraded_scan_count: during.filter((row) => row.state.toUpperCase() === 'DEGRADED').length,
        lost_scan_count: during.filter((row) => row.state.toUpperCase() === 'LOST').length,
        recovered_scan_count: during.filter((row) => row.state.toUpperCase() === 'RECOVERED')
          .length,
        recovery_tracking_ms: recovered ? recovered.timestamp_unix_ms - end.timestamp_ms : null,
        checkpoint_position_error_m: checkpoint
          ? Math.hypot(
              checkpoint.estimate.x - checkpoint.reference.x,
              checkpoint.estimate.y - checkpoint.reference.y,
            )
          : null,
        checkpoint_heading_error_deg: checkpoint
          ? AngleErrorDegrees(checkpoint.estimate.yaw, checkpoint.reference.yaw)
          : null,
        maximum_position_drift_m: maximumPositionDriftM,
        maximum_heading_drift_deg: maximumHeadingDriftDeg,
        robot_stationary:
          maximumPositionDriftM !== null &&
          maximumHeadingDriftDeg !== null &&
          maximumPositionDriftM <= 0.1 &&
          maximumHeadingDriftDeg <= 10,
        object_passing: objectPassing,
      },
    ];
  });
  const dynamicOcclusion = dynamicEvents.length
    ? {
        event_count: dynamicEvents.length,
        completed_marker_count: new Set(dynamicEvents.map((row) => row.trigger_marker)).size,
        valid_duration_count: dynamicEvents.filter((row) => row.duration_valid).length,
        duration_ms: Summarize(dynamicEvents.map((row) => row.duration_ms)),
        accepted_scan_rate: Summarize(
          dynamicEvents.flatMap((row) =>
            row.accepted_scan_rate === null ? [] : [row.accepted_scan_rate],
          ),
        ),
        recovery_tracking_ms: Summarize(
          dynamicEvents.flatMap((row) =>
            row.recovery_tracking_ms === null ? [] : [row.recovery_tracking_ms],
          ),
        ),
        object_detection_available_count: dynamicEvents.filter(
          (row) => row.object_passing.available,
        ).length,
        object_passing_detected_count: dynamicEvents.filter((row) => row.object_passing.detected)
          .length,
        object_passing_detection_rate: dynamicEvents.some((row) => row.object_passing.available)
          ? dynamicEvents.filter((row) => row.object_passing.detected).length /
            dynamicEvents.filter((row) => row.object_passing.available).length
          : null,
        stationary_event_count: dynamicEvents.filter((row) => row.robot_stationary).length,
        events: dynamicEvents,
      }
    : null;
  if (
    runType === 'dynamic_occluded' &&
    dynamicEvents.length &&
    dynamicEvents.some((row) => !row.object_passing.available)
  )
    throw new Error(
      'Dynamic object-passing telemetry is unavailable for one or more markers; verify the board firmware before repeating the trial',
    );
  if (dynamicEvents.length)
    WriteCsv(
      path.join(tables, 'dynamic_occlusion.csv'),
      [
        'trigger_marker',
        'occluder_direction',
        'started_unix_ms',
        'ended_unix_ms',
        'duration_ms',
        'duration_valid',
        'scan_count',
        'accepted_scan_rate',
        'score_minimum',
        'score_mean',
        'score_p95',
        'degraded_scan_count',
        'lost_scan_count',
        'recovered_scan_count',
        'recovery_tracking_ms',
        'checkpoint_position_error_m',
        'checkpoint_heading_error_deg',
        'maximum_position_drift_m',
        'maximum_heading_drift_deg',
        'robot_stationary',
        'object_detection_available',
        'object_passing_detected',
        'observed_pass_direction',
        'left_excess_points',
        'center_excess_points',
        'right_excess_points',
        'minimum_front_range_m',
      ],
      dynamicEvents.map((row) => [
        row.trigger_marker,
        row.occluder_direction,
        row.started_unix_ms,
        row.ended_unix_ms,
        row.duration_ms,
        row.duration_valid,
        row.scan_count,
        row.accepted_scan_rate,
        row.score_minimum,
        row.localization_score.mean,
        row.localization_score.p95,
        row.degraded_scan_count,
        row.lost_scan_count,
        row.recovered_scan_count,
        row.recovery_tracking_ms,
        row.checkpoint_position_error_m,
        row.checkpoint_heading_error_deg,
        row.maximum_position_drift_m,
        row.maximum_heading_drift_deg,
        row.robot_stationary,
        row.object_passing.available,
        row.object_passing.detected,
        row.object_passing.observed_direction,
        row.object_passing.left_excess_points,
        row.object_passing.center_excess_points,
        row.object_passing.right_excess_points,
        row.object_passing.minimum_front_range_m,
      ]),
    );

  const aligned = checkpoints.map((row) => ({
    ...row,
    position_error_m: Math.hypot(
      row.estimate.x - row.reference.x,
      row.estimate.y - row.reference.y,
    ),
    heading_error_deg: AngleErrorDegrees(row.estimate.yaw, row.reference.yaw),
  }));
  const positionErrors = aligned.map((row) => row.position_error_m);
  const headingErrors = aligned.map((row) => row.heading_error_deg);
  WriteCsv(
    path.join(processed, 'aligned_samples.csv'),
    [
      'timestamp_ms',
      'marker_id',
      'zone',
      'truth_x_m',
      'truth_y_m',
      'truth_yaw_rad',
      'estimate_x_m',
      'estimate_y_m',
      'estimate_yaw_rad',
      'score',
      'valid',
      'position_error_m',
      'heading_error_deg',
    ],
    aligned.map((row) => [
      row.timestamp_ms,
      row.marker_id,
      row.zone,
      row.reference.x,
      row.reference.y,
      row.reference.yaw,
      row.estimate.x,
      row.estimate.y,
      row.estimate.yaw,
      row.estimate.score,
      row.estimate.valid,
      row.position_error_m,
      row.heading_error_deg,
    ]),
  );
  WriteCsv(
    path.join(tables, 'accuracy.csv'),
    [
      'metric',
      'n',
      'mean',
      'median',
      'rmse',
      'standard_deviation',
      'p95',
      'maximum',
      'confidence_interval_95_lower',
      'confidence_interval_95_upper',
    ],
    [
      ['position_error_m', ...SummaryValues(Summarize(positionErrors))],
      ['heading_error_deg', ...SummaryValues(Summarize(headingErrors))],
    ],
  );

  const validCheckpoints = aligned.filter((row) => row.estimate.valid);
  const estimateCenter = validCheckpoints.length
    ? {
        x: validCheckpoints.reduce((sum, row) => sum + row.estimate.x, 0) / validCheckpoints.length,
        y: validCheckpoints.reduce((sum, row) => sum + row.estimate.y, 0) / validCheckpoints.length,
        yaw: Math.atan2(
          validCheckpoints.reduce((sum, row) => sum + Math.sin(row.estimate.yaw), 0),
          validCheckpoints.reduce((sum, row) => sum + Math.cos(row.estimate.yaw), 0),
        ),
      }
    : undefined;
  const placementPositionSpread = estimateCenter
    ? validCheckpoints.map((row) =>
        Math.hypot(row.estimate.x - estimateCenter.x, row.estimate.y - estimateCenter.y),
      )
    : [];
  const placementHeadingSpread = estimateCenter
    ? validCheckpoints.map((row) => AngleErrorDegrees(row.estimate.yaw, estimateCenter.yaw))
    : [];

  const releases = events.filter((row) => row.event === 'KIDNAP_RELEASE');
  const recoveryRows = releases.map((release) => {
    const timeout = release.timestamp_ms + 60_000;
    const following = telemetry.filter(
      (row) => row.timestamp_unix_ms >= release.timestamp_ms && row.timestamp_unix_ms <= timeout,
    );
    const recovered = following.find((row) => row.state === 'RECOVERED');
    const stable = following.find(
      (row) =>
        recovered &&
        row.timestamp_unix_ms >= recovered.timestamp_unix_ms &&
        row.state === 'TRACKING',
    );
    const reference = release.reference;
    const firstScan = following[0];
    return {
      release_timestamp_ms: release.timestamp_ms,
      first_scan_after_release_ms: firstScan
        ? firstScan.timestamp_unix_ms - release.timestamp_ms
        : undefined,
      first_recovered_ms: recovered
        ? recovered.timestamp_unix_ms - release.timestamp_ms
        : undefined,
      stable_tracking_ms: stable ? stable.timestamp_unix_ms - release.timestamp_ms : undefined,
      success: Boolean(stable),
      timeout: !stable,
      final_position_error_m:
        stable && reference
          ? Math.hypot(stable.x_m - reference.x, stable.y_m - reference.y)
          : undefined,
      final_heading_error_deg:
        stable && reference ? AngleErrorDegrees(stable.yaw_rad, reference.yaw) : undefined,
      final_score: stable?.score,
      final_state: stable?.state,
    };
  });
  WriteCsv(
    path.join(tables, 'relocalization.csv'),
    [
      'release_timestamp_ms',
      'first_scan_after_release_ms',
      'first_recovered_ms',
      'stable_tracking_ms',
      'success',
      'timeout',
      'final_position_error_m',
      'final_heading_error_deg',
      'final_score',
      'final_state',
    ],
    recoveryRows.map((row) => Object.values(row)),
  );

  const EventWindow = (prefix: string): { start: number; end: number }[] => {
    const starts = events.filter((row) => row.event === `${prefix}_START`);
    const ends = events.filter((row) => row.event === `${prefix}_END`);
    return starts.flatMap((start, index) => {
      const end = ends[index];
      return end && end.timestamp_ms >= start.timestamp_ms
        ? [{ start: start.timestamp_ms, end: end.timestamp_ms }]
        : [];
    });
  };
  const Within = (timestamp: number, windows: { start: number; end: number }[]) =>
    windows.some((window) => timestamp >= window.start && timestamp <= window.end);
  const idleWindows = EventWindow('RESOURCE_IDLE');
  const trackingR1Windows = EventWindow('RESOURCE_TRACKING_R1');
  const trackingR2Windows = EventWindow('RESOURCE_TRACKING_R2');
  const enduranceWindows = EventWindow('RESOURCE_ENDURANCE');
  const enduranceStartEvent = events.find((row) => row.event === 'RESOURCE_ENDURANCE_START');
  const enduranceEndEvent = events.find((row) => row.event === 'RESOURCE_ENDURANCE_END');
  const idleSamples = idleResources.filter((row) => Within(row.timestamp_unix_ms, idleWindows));
  const trackingR1AllSamples = telemetry.filter((row) =>
    Within(row.timestamp_unix_ms, trackingR1Windows),
  );
  const trackingR2AllSamples = telemetry.filter((row) =>
    Within(row.timestamp_unix_ms, trackingR2Windows),
  );
  const trackingR1Samples = trackingR1AllSamples.filter((row) => row.mode === 'tracking');
  const trackingR2Samples = trackingR2AllSamples.filter((row) => row.mode === 'tracking');
  const enduranceTelemetry = telemetry.filter((row) =>
    Within(row.timestamp_unix_ms, enduranceWindows),
  );
  const enduranceResources = idleResources.filter((row) =>
    Within(row.timestamp_unix_ms, enduranceWindows),
  );
  const systemText = fs.existsSync(path.join(raw, 'system.txt'))
    ? fs.readFileSync(path.join(raw, 'system.txt'), 'utf8')
    : '';
  const binarySize = Number(systemText.match(/localize_uart_bytes=(\d+)/)?.[1] || 0);
  const resources = {
    idle: {
      samples: idleSamples.length,
      cpu_percent: Summarize(idleSamples.map((row) => row.process_cpu_percent)),
      peak_rss_kb: Math.max(...idleSamples.map((row) => row.peak_rss_kb), 0),
    },
    tracking_r1: {
      samples: trackingR1Samples.length,
      cpu_percent: Summarize(trackingR1Samples.map((row) => row.process_cpu_percent)),
      peak_rss_kb: Math.max(...trackingR1Samples.map((row) => row.peak_rss_kb), 0),
      processing_time_ms: Summarize(
        trackingR1Samples.map((row) => row.matcher_execution_us / 1000),
      ),
      scan_cycle_ms: Summarize(trackingR1Samples.map((row) => row.scan_cycle_us / 1000)),
      localization_score: Summarize(trackingR1AllSamples.map((row) => row.score)),
      tracking_sample_rate:
        trackingR1AllSamples.length > 0
          ? trackingR1Samples.length / trackingR1AllSamples.length
          : 0,
    },
    tracking_r2: {
      samples: trackingR2Samples.length,
      cpu_percent: Summarize(trackingR2Samples.map((row) => row.process_cpu_percent)),
      peak_rss_kb: Math.max(...trackingR2Samples.map((row) => row.peak_rss_kb), 0),
      processing_time_ms: Summarize(
        trackingR2Samples.map((row) => row.matcher_execution_us / 1000),
      ),
      scan_cycle_ms: Summarize(trackingR2Samples.map((row) => row.scan_cycle_us / 1000)),
      localization_score: Summarize(trackingR2AllSamples.map((row) => row.score)),
      tracking_sample_rate:
        trackingR2AllSamples.length > 0
          ? trackingR2Samples.length / trackingR2AllSamples.length
          : 0,
    },
    endurance: {
      started_unix_ms: enduranceStartEvent?.timestamp_ms ?? null,
      ended_unix_ms: enduranceEndEvent?.timestamp_ms ?? null,
      duration_ms:
        enduranceStartEvent && enduranceEndEvent
          ? enduranceEndEvent.timestamp_ms - enduranceStartEvent.timestamp_ms
          : null,
      samples: enduranceTelemetry.length,
      resource_samples: enduranceTelemetry.length || enduranceResources.length,
      resource_sample_source: enduranceTelemetry.length ? 'scan' : 'heartbeat',
      cpu_percent: Summarize(
        (enduranceTelemetry.length ? enduranceTelemetry : enduranceResources).map(
          (row) => row.process_cpu_percent,
        ),
      ),
      peak_rss_kb: Math.max(
        ...(enduranceTelemetry.length ? enduranceTelemetry : enduranceResources).map(
          (row) => row.peak_rss_kb,
        ),
        0,
      ),
      processing_time_ms: Summarize(
        enduranceTelemetry.map((row) => row.matcher_execution_us / 1000),
      ),
      scan_cycle_ms: Summarize(enduranceTelemetry.map((row) => row.scan_cycle_us / 1000)),
      localization_score: Summarize(enduranceTelemetry.map((row) => row.score)),
      tracking_sample_rate:
        enduranceTelemetry.length > 0
          ? enduranceTelemetry.filter((row) => row.mode === 'tracking').length /
            enduranceTelemetry.length
          : 0,
      accepted_scan_rate:
        enduranceTelemetry.length > 0
          ? enduranceTelemetry.filter((row) => row.accepted).length / enduranceTelemetry.length
          : 0,
    },
    update_rate_hz: Summarize(
      telemetry.slice(1).flatMap((row, index) => {
        const delta = row.timestamp_unix_ms - telemetry[index]!.timestamp_unix_ms;
        return delta > 0 ? [1000 / delta] : [];
      }),
    ),
    binary_size_bytes: binarySize || null,
    measurement_windows: {
      idle: idleWindows.map((window) => window.end - window.start),
      tracking_r1: trackingR1Windows.map((window) => window.end - window.start),
      tracking_r2: trackingR2Windows.map((window) => window.end - window.start),
      endurance: enduranceWindows.map((window) => window.end - window.start),
    },
  };
  WriteCsv(
    path.join(tables, 'resources.csv'),
    ['name', 'value_json'],
    Object.entries(resources).map(([name, value]) => [name, JSON.stringify(value)]),
  );

  WriteCheckpointSvg(path.join(plots, 'checkpoint_comparison.svg'), experimentId, checkpoints);
  WriteTimelineSvg(path.join(plots, 'state_timeline.svg'), experimentId, telemetry);
  WriteErrorSvg(
    path.join(plots, 'error_distribution.svg'),
    experimentId,
    positionErrors,
    headingErrors,
  );

  const summary = {
    schema: 'luckfox.experiment.summary.v1',
    experiment_id: experimentId,
    generated_unix_ms: Date.now(),
    accuracy: {
      checkpoint_count: checkpoints.length,
      successful_checkpoints: validCheckpoints.length,
      success_rate: checkpoints.length ? validCheckpoints.length / checkpoints.length : null,
      position_error_m: Summarize(positionErrors),
      heading_error_deg: Summarize(headingErrors),
    },
    ground_truth_repeatability: {
      marker_count: new Set(checkpoints.map((row) => row.marker_id)).size,
      placement_count: validCheckpoints.length,
      estimate_center: estimateCenter,
      position_spread_m: Summarize(placementPositionSpread),
      heading_spread_deg: Summarize(placementHeadingSpread),
    },
    relocalization: {
      trials: recoveryRows.length,
      successes: recoveryRows.filter((row) => row.success).length,
      timeouts: recoveryRows.filter((row) => row.timeout).length,
      success_rate: recoveryRows.length
        ? recoveryRows.filter((row) => row.success).length / recoveryRows.length
        : null,
      first_recovered_ms: Summarize(
        recoveryRows.flatMap((row) =>
          row.first_recovered_ms === undefined ? [] : [row.first_recovered_ms],
        ),
      ),
      stable_tracking_ms: Summarize(
        recoveryRows.flatMap((row) =>
          row.stable_tracking_ms === undefined ? [] : [row.stable_tracking_ms],
        ),
      ),
    },
    dynamic_occlusion: dynamicOcclusion,
    resources,
  };
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(
    path.join(processed, 'trial_report.json'),
    `${JSON.stringify({ summary, recovery_trials: recoveryRows }, null, 2)}\n`,
    { flag: 'wx' },
  );
  return summary;
}
