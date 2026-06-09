const $ = (id) => document.getElementById(id);
const STAGE = { preparing: '准备中', rendering: '渲染帧', encoding: '编码中', done: '完成', failed: '失败' };

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = ''; $('preview').style.display = 'none'; $('download').style.display = 'none';
  const src = $('source').files[0];
  if (!src) return;
  const fd = new FormData();
  const isZip = /\.zip$/i.test(src.name);
  fd.append(isZip ? 'zip' : 'html', src, src.name);
  for (const k of ['width', 'height', 'fps', 'durationSec', 'codec', 'crf', 'subtitleMode']) fd.append(k, $(k).value);
  if ($('audio').files[0]) fd.append('audio', $('audio').files[0], $('audio').files[0].name);
  if ($('subtitle').files[0]) fd.append('subtitle', $('subtitle').files[0], $('subtitle').files[0].name);

  $('bar').style.display = 'block'; $('fill').style.width = '0';
  const res = await fetch('/api/jobs', { method: 'POST', body: fd });
  if (!res.ok) { $('err').textContent = '提交失败：' + (await res.text()); return; }
  const { id } = await res.json();

  const es = new EventSource(`/api/jobs/${id}/progress`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    $('stage').textContent = (STAGE[ev.stage] || ev.stage) + ' ' + Math.round(ev.progress * 100) + '%';
    $('fill').style.width = Math.round(ev.progress * 100) + '%';
    if (ev.status === 'failed') { es.close(); $('err').textContent = '转换失败：' + (ev.error || ''); }
    if (ev.status === 'done') {
      es.close();
      const url = `/api/jobs/${id}/video`;
      const ext = $('codec').value === 'vp9' ? 'webm' : 'mp4';
      $('preview').src = url; $('preview').style.display = 'block';
      $('download').href = url; $('download').download = 'output.' + ext;
      $('download').textContent = '下载视频'; $('download').style.display = 'inline-block';
    }
  };
  es.onerror = () => { es.close(); };
});
