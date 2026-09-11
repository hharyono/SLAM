import assert from 'node:assert/strict';
import test from 'node:test';
import { alignMappingPose, readAlignment } from './map-alignment.js';

test('mapping pose follows rotation and crop in image-local coordinates', () => {
  const pose = alignMappingPose(
    { x: 12, y: 23, yaw: 0.2 },
    {
      previous_origin_x_m: 10,
      previous_origin_y_m: 20,
      previous_origin_yaw_rad: 0,
      applied_rotation_rad: Math.PI / 2,
      source_known_min_x_m: -5,
      source_known_min_y_m: 1,
    },
  );
  assert.ok(Math.abs(pose.x - 2) < 1e-9);
  assert.ok(Math.abs(pose.y - 1) < 1e-9);
  assert.ok(Math.abs(pose.yaw - (0.2 + Math.PI / 2)) < 1e-9);
});

test('source map yaw is removed before alignment and heading wraps', () => {
  const pose = alignMappingPose(
    { x: 7, y: 22, yaw: -3 },
    {
      previous_origin_x_m: 10,
      previous_origin_y_m: 20,
      previous_origin_yaw_rad: Math.PI / 2,
      applied_rotation_rad: 0,
      source_known_min_x_m: 1,
      source_known_min_y_m: 1,
    },
  );
  assert.ok(Math.abs(pose.x - 1) < 1e-9);
  assert.ok(Math.abs(pose.y - 2) < 1e-9);
  assert.ok(Math.abs(pose.yaw - (-3 + 1.5 * Math.PI)) < 1e-9);
});

test('live mapping retains original coordinates without modifying its input', () => {
  const pose = { x: 3, y: -4, yaw: 0.5 };
  assert.deepEqual(alignMappingPose(pose), pose);
  assert.notEqual(alignMappingPose(pose), pose);
});

test('malformed alignment metadata is rejected', () => {
  for (const value of [null, {}, { applied_rotation_rad: NaN }]) {
    assert.throws(() => readAlignment(value), /Invalid map alignment/);
  }
});
