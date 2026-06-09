import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFrames } from '../src/renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('renders deterministic frames at fixed count', async () => {
  const url = 'file://' + path.join(__dirname, 'fixtures', 'anim.html');
  const frames = [];
  await renderFrames({
    url, width: 320, height: 240, fps: 10, durationSec: 0.5,
    onFrame: async (buf) => { frames.push(buf); },
  });
  assert.equal(frames.length, 5);            // 0.5s * 10fps
  assert.ok(frames[0].length > 0);
  assert.ok(Buffer.isBuffer(frames[0]));
});
