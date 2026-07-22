import fs from 'node:fs';
import path from 'node:path';

type NumericSummary = {
  n: number;
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
  x_m: number;
  y_m: number;
  yaw_rad: number;
  score: number;
  mode: 'global' | 'tracking';
  state: string;
  accepted: boolean;
  candidate_count: number;
  matcher_execution_us: number;
  scan_cycle_us: number;
  process_cpu_percent: number;
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
    pedestrian_direction?: string;
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

type ReplayRow = TelemetryRow & { variant: string };

function ReadJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
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

function AngleErrorDegrees(estimate: number, reference: number): number {
  const wrapped = ((estimate - reference + Math.PI) % (2 * Math.PI)) - Math.PI;
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
  ) as { source_experiment_id: string; source_raw_scan: string };
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
  const variants = ['local_only', 'local_global', 'single_resolution', 'multi_resolution'];
  const rows = variants.map((variant) => {
    const replay = ReadJsonLines<ReplayRow>(path.join(raw, `replay_${variant}.jsonl`));
    if (!replay.length) throw new Error(`Replay output is empty for ${variant}`);
    const initialTracking = replay.findIndex((row) => row.state === 'TRACKING');
    const lostIndex = replay.findIndex(
      (row, index) =>
        index > initialTracking && (row.state === 'LOST' || row.state === 'GLOBAL_SEARCH'),
    );
    const recovered = replay.find(
      (row, index) => index > lostIndex && lostIndex >= 0 && row.state === 'TRACKING',
    );
    const lost = lostIndex >= 0 ? replay[lostIndex] : undefined;
    return {
      variant,
      scans: replay.length,
      success: Boolean(recovered),
      success_rate: recovered ? 1 : 0,
      execution_time_ms: Summarize(replay.map((row) => row.matcher_execution_us / 1000)),
      recovery_time_ms:
        recovered && lost ? recovered.timestamp_unix_ms - lost.timestamp_unix_ms : undefined,
      final_position_error_m:
        recovered && reference
          ? Math.hypot(recovered.x_m - reference.x, recovered.y_m - reference.y)
          : undefined,
      final_heading_error_deg:
        recovered && reference ? AngleErrorDegrees(recovered.yaw_rad, reference.yaw) : undefined,
    };
  });
  WriteCsv(
    path.join(tables, 'ablation.csv'),
    [
      'variant',
      'scans',
      'success',
      'success_rate',
      'execution_time_mean_ms',
      'execution_time_p95_ms',
      'recovery_time_ms',
      'final_position_error_m',
      'final_heading_error_deg',
    ],
    rows.map((row) => [
      row.variant,
      row.scans,
      row.success,
      row.success_rate,
      row.execution_time_ms.mean,
      row.execution_time_ms.p95,
      row.recovery_time_ms,
      row.final_position_error_m,
      row.final_heading_error_deg,
    ]),
  );
  const summary = {
    schema: 'luckfox.experiment.ablation.v1',
    experiment_id: experimentId,
    source_experiment_id: sourceConfig.source_experiment_id,
    generated_unix_ms: Date.now(),
    variants: rows,
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
  if (runType === 'ablation') return AnalyzeAblation(directory, experimentId);
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

  const dynamicStart = events.find((row) => row.event === 'DYNAMIC_OCCLUSION_START');
  const dynamicEnd = events.find((row) => row.event === 'DYNAMIC_OCCLUSION_END');
  const dynamicTelemetry =
    dynamicStart && dynamicEnd
      ? telemetry.filter(
          (row) =>
            row.timestamp_unix_ms >= dynamicStart.timestamp_ms &&
            row.timestamp_unix_ms <= dynamicEnd.timestamp_ms,
        )
      : [];
  const dynamicOcclusion =
    dynamicStart && dynamicEnd
      ? {
          trigger_marker: dynamicStart.data?.trigger_marker,
          pedestrian_direction: dynamicStart.data?.pedestrian_direction,
          started_unix_ms: dynamicStart.timestamp_ms,
          ended_unix_ms: dynamicEnd.timestamp_ms,
          duration_ms: dynamicEnd.timestamp_ms - dynamicStart.timestamp_ms,
          scan_count: dynamicTelemetry.length,
          accepted_scan_rate: dynamicTelemetry.length
            ? dynamicTelemetry.filter((row) => row.accepted).length / dynamicTelemetry.length
            : null,
          localization_score: Summarize(dynamicTelemetry.map((row) => row.score)),
        }
      : null;
  if (dynamicOcclusion)
    WriteCsv(
      path.join(tables, 'dynamic_occlusion.csv'),
      [
        'trigger_marker',
        'pedestrian_direction',
        'started_unix_ms',
        'ended_unix_ms',
        'duration_ms',
        'scan_count',
        'accepted_scan_rate',
        'score_mean',
        'score_p95',
      ],
      [
        [
          dynamicOcclusion.trigger_marker,
          dynamicOcclusion.pedestrian_direction,
          dynamicOcclusion.started_unix_ms,
          dynamicOcclusion.ended_unix_ms,
          dynamicOcclusion.duration_ms,
          dynamicOcclusion.scan_count,
          dynamicOcclusion.accepted_scan_rate,
          dynamicOcclusion.localization_score.mean,
          dynamicOcclusion.localization_score.p95,
        ],
      ],
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

  const tracking = telemetry.filter((row) => row.mode === 'tracking');
  const global = telemetry.filter((row) => row.mode === 'global');
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
  const trackingWindows = EventWindow('RESOURCE_TRACKING');
  const globalWindows = EventWindow('RESOURCE_GLOBAL');
  const idleSamples = idleResources.filter((row) => Within(row.timestamp_unix_ms, idleWindows));
  const trackingSamples = tracking.filter((row) =>
    trackingWindows.length ? Within(row.timestamp_unix_ms, trackingWindows) : true,
  );
  const globalSamples = global.filter((row) =>
    globalWindows.length ? Within(row.timestamp_unix_ms, globalWindows) : true,
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
    normal_tracking: {
      samples: trackingSamples.length,
      cpu_percent: Summarize(trackingSamples.map((row) => row.process_cpu_percent)),
      peak_rss_kb: Math.max(...trackingSamples.map((row) => row.peak_rss_kb), 0),
      processing_time_ms: Summarize(trackingSamples.map((row) => row.matcher_execution_us / 1000)),
      scan_cycle_ms: Summarize(trackingSamples.map((row) => row.scan_cycle_us / 1000)),
    },
    global_relocalization: {
      samples: globalSamples.length,
      cpu_percent: Summarize(globalSamples.map((row) => row.process_cpu_percent)),
      peak_rss_kb: Math.max(...globalSamples.map((row) => row.peak_rss_kb), 0),
      processing_time_ms: Summarize(globalSamples.map((row) => row.matcher_execution_us / 1000)),
      scan_cycle_ms: Summarize(globalSamples.map((row) => row.scan_cycle_us / 1000)),
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
      normal_tracking: trackingWindows.map((window) => window.end - window.start),
      global_relocalization: globalWindows.map((window) => window.end - window.start),
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
