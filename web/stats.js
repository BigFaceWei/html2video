import { api } from './common.js';

const charts = {};
function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new window.Chart(document.getElementById(id), config);
}

export async function renderStats() {
  const [byDate, byProject] = await Promise.all([
    api.statsByDate().catch(() => []),
    api.statsByProject().catch(() => []),
  ]);

  // 按日期：成功/失败堆叠柱
  draw('chartDate', {
    type: 'bar',
    data: {
      labels: byDate.map((d) => d.day),
      datasets: [
        { label: '成功', data: byDate.map((d) => d.done), backgroundColor: '#30d158', stack: 's' },
        { label: '失败', data: byDate.map((d) => d.failed), backgroundColor: '#ff453a', stack: 's' },
      ],
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
  });

  // 按 project：转换数柱
  draw('chartProject', {
    type: 'bar',
    data: {
      labels: byProject.map((p) => p.name),
      datasets: [{ label: '转换数', data: byProject.map((p) => p.total), backgroundColor: '#0071e3' }],
    },
    options: { responsive: true, scales: { y: { beginAtZero: true } } },
  });

  // 编码分布：全局汇总饼
  const codecTotals = {};
  for (const p of byProject) {
    for (const [c, n] of Object.entries(p.codecBreakdown || {})) {
      if (!c) continue; codecTotals[c] = (codecTotals[c] || 0) + n;
    }
  }
  draw('chartCodec', {
    type: 'doughnut',
    data: {
      labels: Object.keys(codecTotals),
      datasets: [{ data: Object.values(codecTotals), backgroundColor: ['#0071e3', '#5e5ce6', '#ff9f0a', '#30d158'] }],
    },
    options: { responsive: true },
  });
}

window.addEventListener('job-done', renderStats);
window.addEventListener('history-changed', renderStats);
renderStats();
