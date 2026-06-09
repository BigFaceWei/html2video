import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-test-'));
after(() => { try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

test('e2e: upload html, poll done, download mp4', async () => {
  const app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const html = '<!doctype html><body><div id=x>hi</div><script>function f(t){document.getElementById("x").style.marginLeft=(t/20)+"px";requestAnimationFrame(f)}requestAnimationFrame(f)</script>';
    const pr = await (await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e' }),
    })).json();
    assert.ok(pr.id);
    const form = new FormData();
    form.append('html', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('width','320'); form.append('height','240');
    form.append('fps','10'); form.append('durationSec','1'); form.append('codec','h264'); form.append('crf','28');
    form.append('projectId', pr.id);
    const r = await fetch(base + '/api/jobs', { method: 'POST', body: form });
    const { id } = await r.json();
    assert.ok(id);
    let status;
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base}/api/jobs/${id}`)).json();
      status = s.status;
      if (status === 'done' || status === 'failed') break;
      await new Promise(r => setTimeout(r, 300));
    }
    assert.equal(status, 'done');
    const vid = await fetch(`${base}/api/jobs/${id}/video`);
    assert.equal(vid.status, 200);
    assert.equal(vid.headers.get('content-type'), 'video/mp4');
    assert.equal(vid.headers.get('accept-ranges'), 'bytes');

    // Range 请求返回 206 + Content-Range（<video> 拖动定位依赖）
    const part = await fetch(`${base}/api/jobs/${id}/video`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.match(part.headers.get('content-range'), /^bytes 0-9\//);
    assert.equal(part.headers.get('content-length'), '10');

    // 任务已终态时连接 SSE：发完快照即结束，不挂起连接
    const sse = await fetch(`${base}/api/jobs/${id}/progress`);
    const body = await sse.text(); // 必须能读到结束（流被服务端关闭）
    assert.match(body, /"status":"done"/);
  } finally {
    await app.close();
  }
});

test('缺 projectId 返回 400', async () => {
  const app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const form = new FormData();
    form.append('html', new Blob(['<!doctype html><body>x'], { type: 'text/html' }), 'index.html');
    form.append('width', '320'); form.append('height', '240');
    form.append('fps', '10'); form.append('durationSec', '1');
    const r = await fetch(base + '/api/jobs', { method: 'POST', body: form });
    assert.equal(r.status, 400);
  } finally { await app.close(); }
});

test('重启后历史可下载、列表可见、可删除', async () => {
  // 第一台 server：建 project + 跑一个 job 到 done
  const a1 = buildServer();
  await a1.listen({ port: 0, host: '127.0.0.1' });
  const b1 = `http://127.0.0.1:${a1.server.address().port}`;
  let jobId, projId;
  try {
    projId = (await (await fetch(b1 + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'restart' }),
    })).json()).id;
    const html = '<!doctype html><body><div id=x>hi</div><script>function f(t){document.getElementById("x").style.marginLeft=(t/20)+"px";requestAnimationFrame(f)}requestAnimationFrame(f)</script>';
    const form = new FormData();
    form.append('html', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('width', '320'); form.append('height', '240');
    form.append('fps', '10'); form.append('durationSec', '1'); form.append('codec', 'h264'); form.append('crf', '28');
    form.append('projectId', projId);
    jobId = (await (await fetch(b1 + '/api/jobs', { method: 'POST', body: form })).json()).id;
    let status;
    for (let i = 0; i < 200; i++) {
      status = (await (await fetch(`${b1}/api/jobs/${jobId}`)).json()).status;
      if (status === 'done' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(status, 'done');
  } finally { await a1.close(); }

  // 第二台 server：同一 DATA_DIR（模拟重启），内存无该 job，仍能下
  const a2 = buildServer();
  await a2.listen({ port: 0, host: '127.0.0.1' });
  const b2 = `http://127.0.0.1:${a2.server.address().port}`;
  try {
    const vid = await fetch(`${b2}/api/jobs/${jobId}/video`);
    assert.equal(vid.status, 200);
    assert.equal(vid.headers.get('content-type'), 'video/mp4');

    const list = await (await fetch(`${b2}/api/jobs?project=${projId}`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, jobId);
    assert.equal(list[0].status, 'done');

    // project 打包下载
    const zip = await fetch(`${b2}/api/projects/${projId}/download`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');

    // 统计
    const byProj = await (await fetch(`${b2}/api/stats?by=project`)).json();
    assert.ok(byProj.find((r) => r.project_id === projId && r.done === 1));
    const byDate = await (await fetch(`${b2}/api/stats?by=date`)).json();
    assert.ok(byDate.length >= 1);

    // 删除
    const del = await fetch(`${b2}/api/jobs/${jobId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const after = await fetch(`${b2}/api/jobs/${jobId}/video`);
    assert.equal(after.status, 404);
  } finally { await a2.close(); }
});
