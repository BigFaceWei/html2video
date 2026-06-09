import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { JobManager } from '../src/jobManager.js';

test('input dir removed after success, output kept', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cl-'));
  const jm = new JobManager({ baseDir: base, pipeline: async (job) => {
    await fs.writeFile(path.join(job.inputDir, 'index.html'), 'x');
    await fs.writeFile(job.output, 'video-bytes');
  }});
  const id = jm.create({}, []);
  await jm.waitFor(id);
  const job = jm.get(id);
  await assert.rejects(() => fs.access(job.inputDir));     // input 已删
  assert.ok(await fs.readFile(job.output, 'utf8'));         // output 保留
  await fs.rm(base, { recursive: true, force: true });
});
