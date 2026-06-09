export const $ = (id) => document.getElementById(id);
export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) n.append(k);
  return n;
};
export const fmtBytes = (b) => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
export const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN');
export const api = {
  async json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  listProjects: () => api.json('/api/projects'),
  createProject: (name) => api.json('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  listJobs: (project) => api.json('/api/jobs' + (project ? `?project=${project}` : '')),
  statsByDate: () => api.json('/api/stats?by=date'),
  statsByProject: () => api.json('/api/stats?by=project'),
};
