import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

test('e2e: upload html, poll done, download mp4', async () => {
  const app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const html = '<!doctype html><body><div id=x>hi</div><script>function f(t){document.getElementById("x").style.marginLeft=(t/20)+"px";requestAnimationFrame(f)}requestAnimationFrame(f)</script>';
    const form = new FormData();
    form.append('html', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('width','320'); form.append('height','240');
    form.append('fps','10'); form.append('durationSec','1'); form.append('codec','h264'); form.append('crf','28');
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
  } finally {
    await app.close();
  }
});
