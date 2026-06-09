import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createEncoder } from '../src/encoder.js';

// 已知合法 1x1 PNG（手工构造 RGB 格式，CRC 正确）
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

function ffprobePackets(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'json', file];
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => code === 0 ? resolve(JSON.parse(out).streams[0]) : reject(new Error('ffprobe ' + code)));
  });
}

test('encodes piped PNG frames into mp4 with correct size and frame count', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-'));
  const out = path.join(dir, 'out.mp4');
  const enc = createEncoder({ output: out, width: 320, height: 240, fps: 10, codec: 'h264', crf: 23 });
  for (let i = 0; i < 10; i++) {
    if (!enc.stdin.write(PNG_1x1)) await new Promise((r) => enc.stdin.once('drain', r));
  }
  enc.stdin.end();
  await enc.done;
  const s = await ffprobePackets(out);
  assert.equal(Number(s.width), 320);
  assert.equal(Number(s.height), 240);
  assert.equal(Number(s.nb_read_packets), 10);
  await fs.rm(dir, { recursive: true, force: true });
});
