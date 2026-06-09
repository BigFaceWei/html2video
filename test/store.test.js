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
