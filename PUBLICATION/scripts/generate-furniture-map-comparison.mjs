import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicationDir = path.resolve(scriptDir, "..");
const slamDir = path.resolve(publicationDir, "..");

function readPgm(filePath) {
  const buffer = fs.readFileSync(filePath);
  let cursor = 0;

  function token() {
    while (cursor < buffer.length) {
      if (buffer[cursor] === 35) {
        while (cursor < buffer.length && buffer[cursor] !== 10) cursor += 1;
      } else if (buffer[cursor] <= 32) {
        cursor += 1;
      } else {
        break;
      }
    }
    const start = cursor;
    while (cursor < buffer.length && buffer[cursor] > 32) cursor += 1;
    return buffer.toString("ascii", start, cursor);
  }

  if (token() !== "P5") throw new Error(`Unsupported PGM format: ${filePath}`);
  const width = Number(token());
  const height = Number(token());
  const maximum = Number(token());
  while (cursor < buffer.length && buffer[cursor] <= 32) cursor += 1;
  if (maximum !== 255) throw new Error(`Expected 8-bit PGM: ${filePath}`);

  const pixels = buffer.subarray(cursor, cursor + width * height);
  if (pixels.length !== width * height) throw new Error(`Truncated PGM: ${filePath}`);
  return { width, height, pixels };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function occupancyClass(value) {
  if (value < 90) return "occupied";
  if (value > 195) return "free";
  return "unknown";
}

function mapRuns(map, x0, y0, scale) {
  const colors = {
    occupied: "#1f2933",
    free: "#ffffff",
    unknown: "#c8ced4",
  };
  const rows = [];
  for (let y = 0; y < map.height; y += 1) {
    let start = 0;
    let current = occupancyClass(map.pixels[y * map.width]);
    for (let x = 1; x <= map.width; x += 1) {
      const next =
        x < map.width ? occupancyClass(map.pixels[y * map.width + x]) : null;
      if (next !== current) {
        rows.push(
          `<rect x="${(x0 + start * scale).toFixed(2)}" y="${(
            y0 +
            y * scale
          ).toFixed(2)}" width="${((x - start) * scale + 0.04).toFixed(
            2,
          )}" height="${(scale + 0.04).toFixed(2)}" fill="${
            colors[current]
          }"/>`,
        );
        start = x;
        current = next;
      }
    }
  }
  return rows.join("\n");
}

function markerLayer(markers, map, x0, y0, scale, resolution) {
  return markers
    .map((marker) => {
      const x = x0 + (marker.x / resolution) * scale;
      const y = y0 + map.height * scale - (marker.y / resolution) * scale;
      return `
        <circle cx="${x.toFixed(2)}" cy="${y.toFixed(
          2,
        )}" r="8.5" fill="#ef4444" stroke="#ffffff" stroke-width="2.5"/>
        <text x="${(x + 11).toFixed(2)}" y="${(y - 9).toFixed(
          2,
        )}" class="marker">${escapeXml(marker.marker_id)}</text>`;
    })
    .join("\n");
}

const resolution = 0.05;
const baseline = readPgm(path.join(slamDir, "maps", "ruang_utama.pgm"));
const changed = readPgm(path.join(slamDir, "maps", "map_occluded.pgm"));
const markers = JSON.parse(
  fs.readFileSync(
    path.join(
      slamDir,
      "EXPERIMENTS",
      "Accepted",
      "RV1106",
      "ROUTE",
      "20260723T074715Z_furniture_changed_route_01_08969e7150d9",
      "config",
      "markers.json",
    ),
    "utf8",
  ),
);

const canvasWidth = 1200;
const canvasHeight = 540;
const panelWidth = 540;
const panelGap = 34;
const panelLeft = 43;
const mapTop = 88;
const maxMapWidth = Math.max(baseline.width, changed.width);
const maxMapHeight = Math.max(baseline.height, changed.height);
const scale = Math.min(500 / maxMapWidth, 412 / maxMapHeight);

function panel(map, index, title) {
  const panelX = panelLeft + index * (panelWidth + panelGap);
  const frameX = panelX + 20;
  const frameY = mapTop;
  const commonWidth = maxMapWidth * scale;
  const commonHeight = maxMapHeight * scale;
  const mapX = frameX;
  const mapY = frameY + commonHeight - map.height * scale;

  return `
    <g>
      <text x="${panelX}" y="55" class="panel-title">${escapeXml(title)}</text>
      <rect x="${frameX}" y="${frameY}" width="${commonWidth.toFixed(
        2,
      )}" height="${commonHeight.toFixed(
        2,
      )}" fill="#ffffff" stroke="#111827" stroke-width="1.5"/>
      ${mapRuns(map, mapX, mapY, scale)}
      ${markerLayer(markers, map, mapX, mapY, scale, resolution)}
    </g>`;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
  <style>
    text { font-family: "DejaVu Sans", Arial, sans-serif; fill: #17202a; }
    .panel-title { font-size: 22px; font-weight: 700; }
    .marker { font-size: 13px; font-weight: 700; paint-order: stroke; stroke: white; stroke-width: 3px; stroke-linejoin: round; }
  </style>
  <rect width="1200" height="540" fill="#ffffff"/>
  ${panel(baseline, 0, "A  Frozen localization reference")}
  ${panel(changed, 1, "B  Furniture Arrangement Change")}
</svg>
`;

const outputPath = path.join(
  publicationDir,
  "figures",
  "furniture-map-comparison.svg",
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, svg.replace(/[ \t]+$/gm, ""));
console.log(`Generated ${path.relative(publicationDir, outputPath)}`);
