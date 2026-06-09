import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderFrames } from '../src/renderer.js';
import { createEncoder } from '../src/encoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function probe(file) {
  return new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v','error','-select_streams','v:0','-count_packets',
      '-show_entries','stream=width,height,nb_read_packets','-of','json',file]);
    let o=''; p.stdout.on('data',d=>o+=d);
    p.on('close',c=>c===0?res(JSON.parse(o).streams[0]):rej(new Error('ffprobe')));
  });
}

test('render -> encode produces correct mp4', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipe-'));
  const out = path.join(dir, 'out.mp4');
  const enc = createEncoder({ output: out, width: 320, height: 240, fps: 10, codec: 'h264', crf: 23 });
  const url = 'file://' + path.join(__dirname, 'fixtures', 'anim.html');
  await renderFrames({ url, width: 320, height: 240, fps: 10, durationSec: 1,
    onFrame: async (buf) => { if (!enc.stdin.write(buf)) await new Promise(r=>enc.stdin.once('drain',r)); } });
  enc.stdin.end();
  await enc.done;
  const s = await probe(out);
  assert.equal(Number(s.width), 320);
  assert.equal(Number(s.nb_read_packets), 10);
  await fs.rm(dir, { recursive: true, force: true });
});
