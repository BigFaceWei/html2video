import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { JobManager } from '../src/jobManager.js';

test('runs job through states to done', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
  const states = [];
  const jm = new JobManager({
    baseDir: base,
    pipeline: async (job, report) => { report('rendering', 0.5); report('encoding', 1); },
  });
  const id = jm.create({ durationSec: 1, fps: 10 }, []);
  jm.on(id, (ev) => states.push(ev.stage));
  await jm.waitFor(id);
  assert.equal(jm.get(id).status, 'done');
  assert.ok(states.includes('rendering'));
  assert.ok(states.includes('encoding'));
  await fs.rm(base, { recursive: true, force: true });
});

test('failed pipeline marks job failed with error', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
  const jm = new JobManager({ baseDir: base, pipeline: async () => { throw new Error('boom'); } });
  const id = jm.create({ durationSec: 1, fps: 10 }, []);
  await jm.waitFor(id);
  assert.equal(jm.get(id).status, 'failed');
  assert.match(jm.get(id).error, /boom/);
  await fs.rm(base, { recursive: true, force: true });
});

test('jobs run serially (concurrency 1)', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
  let active = 0, maxActive = 0;
  const jm = new JobManager({ baseDir: base, pipeline: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 20)); active--;
  }});
  const a = jm.create({}, []); const b = jm.create({}, []);
  await Promise.all([jm.waitFor(a), jm.waitFor(b)]);
  assert.equal(maxActive, 1);
  await fs.rm(base, { recursive: true, force: true });
});
