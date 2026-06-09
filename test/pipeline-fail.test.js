import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makePipeline } from '../src/pipeline.js';

test('pipeline rejects (no hang) when ffmpeg fails to write output', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-'));
  const inputDir = path.join(base, 'input');
  await fs.mkdir(inputDir, { recursive: true });
  const pipeline = makePipeline();
  const job = {
    inputDir,
    // 不存在且不可创建的输出目录 → ffmpeg 立即非 0 退出
    output: path.join(base, 'no', 'such', 'dir', 'out.mp4'),
    files: { html: Buffer.from('<!doctype html><body><script>function f(t){requestAnimationFrame(f)}requestAnimationFrame(f)</script>') },
    params: { width: 320, height: 240, fps: 10, durationSec: 3, codec: 'h264', crf: 30, subtitleMode: 'burn' },
  };
  await assert.rejects(() => pipeline(job, () => {}));
  await fs.rm(base, { recursive: true, force: true });
});
