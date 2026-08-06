#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicationDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(publicationDir, '..');
const acceptedDir = path.join(
  repositoryDir,
  'EXPERIMENTS',
  'Accepted',
  'RV1103',
  'DYNAMIC OCCLUDED',
);

const sessionNames = fs.readdirSync(acceptedDir).sort();
const sessions = sessionNames.map((sessionName) => {
  const base = path.join(acceptedDir, sessionName);
  return {
    sessionName,
    session: JSON.parse(fs.readFileSync(path.join(base, 'config/session.json'), 'utf8')),
    summary: JSON.parse(fs.readFileSync(path.join(base, 'processed/summary.json'), 'utf8')),
  };
});

if (sessions.length !== 2) {
  throw new Error(`Expected two Accepted RV1103 dynamic-occlusion sessions; found ${sessions.length}`);
}

const eventRows = sessions
  .flatMap(({ session, summary }) => {
    const route = session.route_id?.startsWith('R2') ? 'R2' : 'R1';
    return (summary.dynamic_occlusion?.events ?? []).map((event) => ({
      route,
      marker: event.trigger_marker,
      scans: event.scan_count,
      acceptedRate: event.accepted_scan_rate,
      positionDrift: event.maximum_position_drift_m,
      left: event.object_passing?.left_excess_points ?? 0,
      center: event.object_passing?.center_excess_points ?? 0,
      right: event.object_passing?.right_excess_points ?? 0,
      minimumRange: event.object_passing?.minimum_front_range_m,
    }));
  })
  .sort(
    (left, right) =>
      left.route.localeCompare(right.route) ||
      Number(left.marker.slice(1)) - Number(right.marker.slice(1)),
  );

if (eventRows.length !== 12) {
  throw new Error(`Expected 12 M2–M7 events; found ${eventRows.length}`);
}

const totalScans = eventRows.reduce((sum, event) => sum + event.scans, 0);
const acceptedScans = eventRows.reduce(
  (sum, event) => sum + Math.round(event.scans * event.acceptedRate),
  0,
);
const maximumDrift = Math.max(...eventRows.map((event) => event.positionDrift));
const minimumRange = Math.min(
  ...eventRows
    .map((event) => event.minimumRange)
    .filter((value) => Number.isFinite(value)),
);

function readPgm(filePath) {
  const buffer = fs.readFileSync(filePath);
  let cursor = 0;
  const token = () => {
    while (cursor < buffer.length) {
      if (buffer[cursor] === 35) {
        while (cursor < buffer.length && buffer[cursor] !== 10) cursor += 1;
      } else if (/\s/.test(String.fromCharCode(buffer[cursor]))) {
        cursor += 1;
      } else {
        break;
      }
    }
    const start = cursor;
    while (
      cursor < buffer.length &&
      !/\s/.test(String.fromCharCode(buffer[cursor])) &&
      buffer[cursor] !== 35
    ) {
      cursor += 1;
    }
    return buffer.subarray(start, cursor).toString('ascii');
  };

  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const maximum = Number(token());
  while (cursor < buffer.length && /\s/.test(String.fromCharCode(buffer[cursor]))) cursor += 1;
  if (magic !== 'P5' || maximum > 255) {
    throw new Error(`Unsupported PGM format ${magic}, maximum ${maximum}`);
  }
  return { width, height, pixels: buffer.subarray(cursor, cursor + width * height) };
}

const map = readPgm(path.join(repositoryDir, 'maps', 'map_rv1103.pgm'));
const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const round = (value) => Number(value.toFixed(2));

const width = 1200;
const height = 600;
const mapFrame = { x: 70, y: 70, width: 500, height: 412 };
const table = { x: 630, y: 77, width: 505, headerHeight: 34, rowHeight: 28 };
const mapScale = Math.min(mapFrame.width / map.width, mapFrame.height / map.height);
const renderedMapWidth = map.width * mapScale;
const renderedMapHeight = map.height * mapScale;
const mapX = mapFrame.x + (mapFrame.width - renderedMapWidth) / 2;
const mapY = mapFrame.y + (mapFrame.height - renderedMapHeight) / 2;
const worldToMap = (x, y) => ({
  x: mapX + (x / 0.05) * mapScale,
  y: mapY + renderedMapHeight - (y / 0.05) * mapScale,
});

let mapRuns = '';
for (let row = 0; row < map.height; row += 1) {
  let start = 0;
  while (start < map.width) {
    const pixel = map.pixels[row * map.width + start];
    const category = pixel < 80 ? 'occupied' : pixel > 220 ? 'free' : 'unknown';
    let end = start + 1;
    while (end < map.width) {
      const next = map.pixels[row * map.width + end];
      const nextCategory = next < 80 ? 'occupied' : next > 220 ? 'free' : 'unknown';
      if (nextCategory !== category) break;
      end += 1;
    }
    const fill = category === 'occupied' ? '#26313a' : category === 'free' ? '#f8fafc' : '#dce3e8';
    mapRuns += `<rect x="${round(mapX + start * mapScale)}" y="${round(
      mapY + row * mapScale,
    )}" width="${round((end - start) * mapScale + 0.2)}" height="${round(
      mapScale + 0.2,
    )}" fill="${fill}"/>`;
    start = end;
  }
}

const routeMarkers = sessions[0].session.route_markers;
const markerSvg = routeMarkers
  .map((marker) => {
    const point = worldToMap(marker.x, marker.y);
    const crossing = !['M1', 'M8'].includes(marker.marker_id);
    return `<g>
      <circle cx="${round(point.x)}" cy="${round(point.y)}" r="${crossing ? 15 : 13}"
        fill="${crossing ? '#e76f51' : '#2a9d8f'}" stroke="#ffffff" stroke-width="2.5"/>
      <text x="${round(point.x)}" y="${round(point.y + 4)}" text-anchor="middle"
        class="marker-label">${esc(marker.marker_id)}</text>
    </g>`;
  })
  .join('');

const projectedMarkerIds = ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
const projectionEvents = projectedMarkerIds.map((markerId) => {
  const candidates = eventRows.filter((event) => event.marker === markerId);
  const event = candidates.sort(
    (left, right) =>
      right.left +
      right.center +
      right.right -
      (left.left + left.center + left.right),
  )[0];
  const marker = routeMarkers.find((item) => item.marker_id === markerId);
  if (!event || !marker) {
    throw new Error(`Missing dynamic-occlusion projection evidence for ${markerId}`);
  }
  return { event, marker };
});

const objectProjectionSvg = projectionEvents
  .flatMap(({ event, marker }) => {
    const sectors = [
      { value: event.left, fromDeg: 15, toDeg: 55 },
      { value: event.center, fromDeg: -8, toDeg: 8 },
      { value: event.right, fromDeg: -55, toDeg: -15 },
    ];
    return sectors
      .filter((sector) => sector.value > 0)
      .flatMap((sector) => {
        const dotCount = Math.max(1, Math.ceil(sector.value / 4));
        return Array.from({ length: dotCount }, (_, index) => {
          const fraction = dotCount === 1 ? 0.5 : index / (dotCount - 1);
          const bearing =
            marker.yaw +
            ((sector.fromDeg + (sector.toDeg - sector.fromDeg) * fraction) *
              Math.PI) /
              180;
          const range = event.minimumRange + 0.035 * (index % 3);
          const point = worldToMap(
            marker.x + range * Math.cos(bearing),
            marker.y + range * Math.sin(bearing),
          );
          return `<circle cx="${round(point.x)}" cy="${round(
            point.y,
          )}" r="3.3" fill="#111827" stroke="#ffffff" stroke-width="0.8"/>`;
        });
      });
  })
  .join('');

const sectorColumns = [
  { key: 'left', label: 'LEFT', x: 78, width: 62, color: '#2563eb' },
  { key: 'center', label: 'CENTER', x: 146, width: 62, color: '#e76f51' },
  { key: 'right', label: 'RIGHT', x: 214, width: 62, color: '#16a34a' },
];
const maximumSectorValue = Math.max(
  ...eventRows.flatMap((event) => [event.left, event.center, event.right]),
  1,
);
const sectorCell = (event, column, y) => {
  const value = event[column.key];
  const opacity = value > 0 ? 0.16 + 0.7 * (value / maximumSectorValue) : 0;
  const display = value > 0 ? value.toFixed(value % 1 === 0 ? 0 : 1) : '—';
  return `<rect x="${table.x + column.x}" y="${y + 3}" width="${column.width}"
      height="${table.rowHeight - 6}" rx="4"
      fill="${value > 0 ? column.color : '#f1f4f6'}" fill-opacity="${
        value > 0 ? opacity.toFixed(2) : 1
      }"/>
    <text x="${table.x + column.x + column.width / 2}" y="${y + 19}"
      text-anchor="middle" class="cell-value">${display}</text>`;
};

const tableHeader = `<rect x="${table.x}" y="${table.y}" width="${table.width}"
    height="${table.headerHeight}" rx="7" fill="#263746"/>
  <text x="${table.x + 12}" y="${table.y + 22}" class="header-label">EVENT</text>
  ${sectorColumns
    .map(
      (column) =>
        `<text x="${table.x + column.x + column.width / 2}" y="${table.y + 22}"
          text-anchor="middle" class="header-label">${column.label}</text>`,
    )
    .join('')}
  <text x="${table.x + 326}" y="${table.y + 22}" text-anchor="middle"
    class="header-label">MIN RANGE</text>
  <text x="${table.x + 438}" y="${table.y + 22}" text-anchor="middle"
    class="header-label">ACCEPTED</text>`;

const tableRows = eventRows
  .map((event, index) => {
    const y = table.y + table.headerHeight + index * table.rowHeight;
    const rowFill = index % 2 === 0 ? '#ffffff' : '#f7f9fb';
    const routeColor = event.route === 'R1' ? '#7c3aed' : '#b45309';
    return `<g>
      <rect x="${table.x}" y="${y}" width="${table.width}" height="${table.rowHeight}"
        fill="${rowFill}"/>
      <rect x="${table.x}" y="${y + 4}" width="4" height="${table.rowHeight - 8}"
        rx="2" fill="${routeColor}"/>
      <text x="${table.x + 12}" y="${y + 19}" class="event-label">${event.route} ${esc(
        event.marker,
      )}</text>
      ${sectorColumns.map((column) => sectorCell(event, column, y)).join('')}
      <text x="${table.x + 326}" y="${y + 19}" text-anchor="middle"
        class="cell-value">${event.minimumRange.toFixed(3)} m</text>
      <text x="${table.x + 438}" y="${y + 19}" text-anchor="middle"
        class="cell-value">${(event.acceptedRate * 100).toFixed(2)}%</text>
    </g>`;
  })
  .join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
  viewBox="0 0 ${width} ${height}" role="img"
  aria-labelledby="title description">
  <title id="title">RV1103 dynamic-occlusion checkpoints and all-event LiDAR sector evidence</title>
  <desc id="description">The map marks M1 through M8 without a route line. The evidence matrix
  reports left, center, and right near-sector excess for every R1 and R2 event at M2 through M7.
  A single non-zero sector remains visible when an event appears in only one sector. Black dots
  at M2 through M7 are evidence-derived schematic projections of the strongest recorded sector
  response at each marker, not raw LiDAR beam endpoints.</desc>
  <style>
    text { font-family: Arial, Helvetica, sans-serif; fill: #17212b; }
    .subtitle { font-size: 14px; fill: #53616d; }
    .panel { font-size: 17px; font-weight: 700; }
    .legend { font-size: 12px; font-weight: 600; }
    .marker-label { font-size: 10px; font-weight: 700; fill: white; }
    .header-label { font-size: 10px; font-weight: 700; fill: white; }
    .event-label { font-size: 12px; font-weight: 700; }
    .cell-value { font-size: 11px; font-weight: 600; }
    .metric-label { font-size: 11px; fill: #64727e; }
    .metric-value { font-size: 17px; font-weight: 700; }
  </style>
  <rect width="1200" height="${height}" fill="#ffffff"/>

  <text x="60" y="45" class="panel">(a)</text>
  <rect x="${mapFrame.x}" y="${mapFrame.y}" width="${mapFrame.width}" height="${
    mapFrame.height
  }" rx="8" fill="#edf2f5" stroke="#cad5dc"/>
  <defs><clipPath id="map-clip"><rect x="${mapFrame.x}" y="${mapFrame.y}" width="${
    mapFrame.width
  }" height="${mapFrame.height}" rx="8"/></clipPath></defs>
  <g clip-path="url(#map-clip)">${mapRuns}</g>
  <g clip-path="url(#map-clip)">${objectProjectionSvg}</g>
  ${markerSvg}
  <g transform="translate(82,505)">
    <circle cx="8" cy="0" r="7" fill="#2a9d8f"/><text x="22" y="5" class="legend">M1/M8 endpoints</text>
    <circle cx="182" cy="0" r="7" fill="#e76f51"/><text x="196" y="5" class="legend">M2–M7 tested points</text>
  </g>
  <g transform="translate(82,529)">
    <circle cx="8" cy="0" r="3.3" fill="#111827"/><text x="22" y="5" class="legend">Evidence-derived moving-object projections at M2–M7</text>
  </g>

  <text x="630" y="45" class="panel">(b)</text>
  ${tableHeader}
  ${tableRows}
  <text x="${table.x}" y="463" class="subtitle">L/C/R = excess near returns vs 1 s baseline (range 0.30–0.80 m).</text>
  <text x="${table.x}" y="483" class="subtitle">Angles: L +10°…+65° · C −10°…+10° · R −65°…−10° · “—” = no excess.</text>

  <g transform="translate(630,505)">
    <rect width="505" height="52" rx="8" fill="#f3f6f8"/>
    <g transform="translate(18,16)">
      <text class="metric-label">EVENTS</text><text y="24" class="metric-value">${eventRows.length}/${eventRows.length}</text>
    </g>
    <g transform="translate(112,16)">
      <text class="metric-label">TESTED MARKERS</text><text y="24" class="metric-value">M2–M7</text>
    </g>
    <g transform="translate(240,16)">
      <text class="metric-label">ACCEPTED SCANS</text><text y="24" class="metric-value">${acceptedScans}/${totalScans} (${(
        (acceptedScans / totalScans) *
        100
      ).toFixed(2)}%)</text>
    </g>
    <g transform="translate(405,16)">
      <text class="metric-label">MIN RANGE</text><text y="24" class="metric-value">${minimumRange.toFixed(
        3,
      )} m</text>
    </g>
  </g>
  <text x="60" y="581" class="subtitle">0.05 m/pixel · finalized source telemetry · maximum event-window position drift ${maximumDrift.toFixed(
    3,
  )} m</text>
</svg>`;

const outputPath = path.join(publicationDir, 'figures', 'dynamic-occlusion-evidence.svg');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath}`);
