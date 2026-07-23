import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AngleErrorDegrees, ReadJsonLines } from './experiment-analysis.js';

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
