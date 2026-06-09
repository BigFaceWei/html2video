import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function freshStore() { return createStore(':memory:'); }

test('createProject 幂等且 name 唯一', () => {
  const s = freshStore();
  const a = s.createProject('demo');
  const b = s.createProject('demo');
  assert.equal(a.id, b.id);            // 同名返回现有
  assert.equal(a.name, 'demo');
  assert.ok(a.id && a.created_at);
  s.close();
});

test('listProjects 带 jobCount/doneCount', () => {
  const s = freshStore();
  const p = s.createProject('p1');
  s.insertJob({ id: 'j1', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.insertJob({ id: 'j2', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.markDone('j1', { size_bytes: 100 });
  const list = s.listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].jobCount, 2);
  assert.equal(list[0].doneCount, 1);
  s.close();
});

test('getJob 反序列化 params，listJobs 按 project 过滤倒序', () => {
  const s = freshStore();
  const p = s.createProject('p');
  s.insertJob({ id: 'a', project_id: p.id, params: { codec: 'vp9', fps: 30 }, output_ext: 'webm' });
  s.insertJob({ id: 'b', project_id: p.id, params: { codec: 'h264', fps: 24 }, output_ext: 'mp4' });
  const job = s.getJob('a');
  assert.equal(job.params.codec, 'vp9');     // params 已 JSON.parse
  assert.equal(job.output_ext, 'webm');
  assert.equal(job.status, 'queued');
  const all = s.listJobs({ project_id: p.id });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'b');              // created_at 倒序，后插的在前
  assert.equal(s.getJob('missing'), null);
  s.close();
});

test('statsByProject 含成功失败计数、字节、codec 分布', () => {
  const s = freshStore();
  const p = s.createProject('proj');
  s.insertJob({ id: 'x', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.insertJob({ id: 'y', project_id: p.id, params: { codec: 'vp9' }, output_ext: 'webm' });
  s.markDone('x', { size_bytes: 500 });
  s.markFailed('y', 'boom');
  const st = s.statsByProject();
  const row = st.find((r) => r.project_id === p.id);
  assert.equal(row.total, 2);
  assert.equal(row.done, 1);
  assert.equal(row.failed, 1);
  assert.equal(row.bytes, 500);
  assert.equal(row.codecBreakdown.h264, 1);
  assert.equal(row.codecBreakdown.vp9, 1);
  s.close();
});

test('statsByDate 按天聚合', () => {
  const s = freshStore();
  const p = s.createProject('proj');
  s.insertJob({ id: 'd1', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.markDone('d1', { size_bytes: 10 });
  const rows = s.statsByDate();
  assert.equal(rows.length, 1);
  assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rows[0].total, 1);
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].bytes, 10);
  s.close();
});
