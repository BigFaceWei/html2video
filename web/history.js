import { $, api, el, fmtBytes, fmtTime } from './common.js';

const STATUS_CN = { done: '完成', failed: '失败', queued: '排队', running: '进行中' };

async function refreshFilter() {
  const projects = await api.listProjects().catch(() => []);
  const sel = $('histFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 project</option>';
  const byId = {};
  for (const p of projects) {
    byId[p.id] = p.name;
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name; sel.append(o);
  }
  if (cur) sel.value = cur;
  return byId;
}

export async function renderHistory() {
  const byId = await refreshFilter();
  const project = $('histFilter').value;
  const jobs = await api.listJobs(project).catch(() => []);
  const list = $('histList');
  list.innerHTML = '';

  // project 打包下载按钮：仅选中具体 project 时显示
  const zip = $('histZip');
  if (project) { zip.style.display = 'inline-block'; zip.href = `/api/projects/${project}/download`; }
  else zip.style.display = 'none';

  if (jobs.length === 0) { list.innerHTML = '<p class="hist-meta">暂无记录</p>'; return; }

  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    const p = j.params || {};
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'hist-title';
    const titleText = document.createElement('span');
    titleText.textContent = `${byId[j.project_id] || '—'} · ${(p.codec || '').toUpperCase()} `;
    const badge = document.createElement('span');
    badge.className = `badge ${j.status}`;
    badge.textContent = STATUS_CN[j.status] || j.status;
    title.append(titleText, badge);
    const meta = document.createElement('div');
    meta.className = 'hist-meta';
    meta.textContent = `${fmtTime(j.created_at)} · ${p.width}×${p.height} @${p.fps}fps · ${fmtBytes(j.size_bytes)}`;
    left.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'hist-actions';
    if (j.status === 'done') {
      const dl = document.createElement('a');
      dl.className = 'hist-btn'; dl.textContent = '下载';
      dl.href = `/api/jobs/${j.id}/video`; dl.download = `${j.id}.${j.output_ext}`;
      actions.append(dl);
    }
    const del = document.createElement('a');
    del.className = 'hist-btn danger'; del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm('删除该记录与产物？')) return;
      await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
      renderHistory(); window.dispatchEvent(new CustomEvent('history-changed'));
    };
    actions.append(del);
    row.append(left, actions);
    list.append(row);
  }
}

$('histFilter').addEventListener('change', renderHistory);
window.addEventListener('job-done', renderHistory);
renderHistory();
