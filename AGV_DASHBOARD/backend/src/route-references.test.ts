import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RouteReferenceStore } from './route-references.js';

function Markers() {
  return Array.from({ length: 8 }, (_, index) => ({
    marker_id: `M${index + 1}`,
    zone: index < 4 ? 'room_1' : 'room_2',
    x: index + 0.25,
    y: index + 1.5,
    yaw: index * 0.1,
  }));
}

test('named route references are stored only in the Global route catalog', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-route-reference-'));
  try {
    const store = new RouteReferenceStore(outputRoot);
    const created = store.Create({ name: 'RV1103 Main Route', markers: Markers() });
    assert.equal(created.reference_id, 'rv1103-main-route');
    assert.deepEqual(store.List(), [created]);
    assert.ok(fs.existsSync(path.join(outputRoot, 'Global', 'routes', 'rv1103-main-route.json')));
    assert.deepEqual(fs.readdirSync(outputRoot).sort(), ['Global']);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('route reference names are unique and marker data is validated', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckfox-route-reference-'));
  try {
    const store = new RouteReferenceStore(outputRoot);
    store.Create({ name: 'Route A', markers: Markers() });
    assert.throws(() => store.Create({ name: 'route a', markers: Markers() }), /already exists/);
    assert.throws(
      () => store.Create({ name: 'Incomplete', markers: Markers().slice(0, 7) }),
      /exactly 8/,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
