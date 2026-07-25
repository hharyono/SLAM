import fs from 'node:fs';
import path from 'node:path';

export type RouteReferenceMarker = {
  marker_id: string;
  zone: string;
  x: number;
  y: number;
  yaw: number;
};

export type RouteReference = {
  schema: 'luckfox.route-reference.v1';
  reference_id: string;
  name: string;
  created_unix_ms: number;
  markers: RouteReferenceMarker[];
  legacy?: boolean;
};

const ValidZones = new Set(['room_1', 'doorway_transition', 'room_2', 'cross_room']);

function ValidateMarkers(value: unknown): RouteReferenceMarker[] {
  if (!Array.isArray(value) || value.length !== 8)
    throw new Error('A route reference requires exactly 8 markers');
  const markers = value.map((candidate, index) => {
    const marker = candidate as Partial<RouteReferenceMarker>;
    const markerId = String(marker.marker_id || '')
      .trim()
      .slice(0, 40);
    const zone = String(marker.zone || '').trim();
    const x = Number(marker.x);
    const y = Number(marker.y);
    const yaw = Number(marker.yaw);
    if (!markerId) throw new Error(`Route marker ${index + 1} requires an ID`);
    if (!ValidZones.has(zone)) throw new Error(`Route marker ${markerId} has an invalid zone`);
    if (![x, y, yaw].every(Number.isFinite))
      throw new Error(`Route marker ${markerId} requires finite X, Y, and yaw values`);
    return { marker_id: markerId, zone, x, y, yaw };
  });
  if (new Set(markers.map((marker) => marker.marker_id.toUpperCase())).size !== 8)
    throw new Error('Route marker IDs must be unique');
  return markers;
}

function Slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class RouteReferenceStore {
  private readonly GlobalDirectory: string;
  private readonly CatalogDirectory: string;

  constructor(experimentOutputDirectory: string) {
    this.GlobalDirectory = path.join(experimentOutputDirectory, 'Global');
    this.CatalogDirectory = path.join(this.GlobalDirectory, 'routes');
    fs.mkdirSync(this.CatalogDirectory, { recursive: true });
  }

  List(): RouteReference[] {
    const references: RouteReference[] = [];
    for (const entry of fs.readdirSync(this.CatalogDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.CatalogDirectory, entry.name);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RouteReference>;
      const referenceId = String(parsed.reference_id || '').trim();
      const name = String(parsed.name || '').trim();
      if (!referenceId || !name) throw new Error(`Invalid route reference in ${entry.name}`);
      references.push({
        schema: 'luckfox.route-reference.v1',
        reference_id: referenceId,
        name,
        created_unix_ms: Number(parsed.created_unix_ms) || fs.statSync(file).mtimeMs,
        markers: ValidateMarkers(parsed.markers),
      });
    }
    for (const [filename, referenceId, name] of [
      ['markers_R1.json', 'rv1106-marker1-r1', 'RV1106_Marker1_R1'],
      ['markers_R2.json', 'rv1106-marker1-r2', 'RV1106_Marker1_R2'],
    ] as const) {
      const file = path.join(this.GlobalDirectory, filename);
      if (!fs.existsSync(file) || references.some((item) => item.reference_id === referenceId))
        continue;
      references.push({
        schema: 'luckfox.route-reference.v1',
        reference_id: referenceId,
        name,
        created_unix_ms: fs.statSync(file).mtimeMs,
        markers: ValidateMarkers(JSON.parse(fs.readFileSync(file, 'utf8'))),
        legacy: true,
      });
    }
    return references.sort((left, right) => left.name.localeCompare(right.name));
  }

  Create(input: { name?: unknown; markers?: unknown }): RouteReference {
    const name = String(input.name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!name) throw new Error('Route reference name is required');
    const referenceId = Slug(name);
    if (!referenceId) throw new Error('Route reference name must contain letters or numbers');
    if (
      this.List().some(
        (reference) =>
          reference.reference_id === referenceId ||
          reference.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      throw new Error(`Route reference "${name}" already exists; use a different name`);
    const reference: RouteReference = {
      schema: 'luckfox.route-reference.v1',
      reference_id: referenceId,
      name,
      created_unix_ms: Date.now(),
      markers: ValidateMarkers(input.markers),
    };
    const destination = path.join(this.CatalogDirectory, `${referenceId}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(reference, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, destination);
    return reference;
  }
}
