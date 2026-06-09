import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { JobManager } from './jobManager.js';
import { makePipeline } from './pipeline.js';
import { createStore } from './store.js';

export async function registerRoutes(app) {
  // 在 registerRoutes 调用时（buildServer 内）解析，确保测试先设 process.env.DATA_DIR 生效。
  // 勿提到模块顶层：ESM import 会先于测试设置 env 求值，导致路径被冻结为默认值。
  const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const DB_PATH = path.join(DATA_DIR, 'html2video.db');
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const store = createStore(DB_PATH);
  const jm = new JobManager({ baseDir: DATA_DIR, pipeline: makePipeline(), store });
  app.addHook('onClose', async () => { try { store.close(); } catch (_) {} });

  const outputPath = (id, ext) => path.join(DATA_DIR, id, `output.${ext}`);

  app.get('/api/health', async () => ({ ok: true }));

  // ---- projects ----
  app.post('/api/projects', async (req, reply) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name required' });
    return store.createProject(name);
  });

  app.get('/api/projects', async () => store.listProjects());

  app.delete('/api/projects/:id', async (req, reply) => {
    const p = store.getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const active = store.listJobs({ project_id: p.id, limit: 100000 })
      .filter((j) => j.status !== 'done' && j.status !== 'failed');
    if (active.length) return reply.code(409).send({ error: 'project has active jobs' });
    for (const j of store.listJobs({ project_id: p.id, limit: 100000 })) {
      try { await fsp.rm(path.join(DATA_DIR, j.id), { recursive: true, force: true }); } catch (_) {}
    }
    store.deleteProject(p.id);
    return { ok: true };
  });

  app.get('/api/projects/:id/download', async (req, reply) => {
    const p = store.getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const zip = new AdmZip();
    let count = 0;
    for (const j of store.listJobs({ project_id: p.id, limit: 100000 })) {
      if (j.status !== 'done') continue;
      const fp = outputPath(j.id, j.output_ext);
      if (!fs.existsSync(fp)) continue;     // 个别缺失跳过，不整体失败
      zip.addLocalFile(fp, '', `${j.id}.${j.output_ext}`);
      count++;
    }
    if (count === 0) return reply.code(404).send({ error: 'no videos' });
    const safe = (p.name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64) || 'project');
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safe + '.zip')}`);
    return reply.send(zip.toBuffer());
  });

  // ---- jobs ----
  app.post('/api/jobs', async (req, reply) => {
    const files = {}; const fields = {};
    let badExt = null; let sourceName = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        const name = String(part.filename || '');
        if (part.fieldname === 'html') {
          if (!/\.html?$/i.test(name)) badExt = 'html 文件需 .html/.htm 扩展名';
          files.html = buf; sourceName = name;
        } else if (part.fieldname === 'zip') {
          if (!/\.zip$/i.test(name)) badExt = 'zip 文件需 .zip 扩展名';
          files.zip = buf; sourceName = name;
        } else if (part.fieldname === 'audio') files.audio = { name: sanitize(part.filename), buffer: buf };
        else if (part.fieldname === 'subtitle') files.subtitle = { name: sanitize(part.filename), buffer: buf };
      } else { fields[part.fieldname] = part.value; }
    }
    if (badExt) return reply.code(400).send({ error: badExt });
    if (!files.html && !files.zip) return reply.code(400).send({ error: 'html or zip required' });

    const projectId = fields.projectId;
    if (!projectId || !store.getProject(projectId)) {
      return reply.code(400).send({ error: 'valid projectId required' });
    }

    const params = {
      width: clampInt(fields.width, 16, 7680, 1920),
      height: clampInt(fields.height, 16, 4320, 1080),
      fps: clampInt(fields.fps, 1, 120, 30),
      durationSec: Math.min(600, Math.max(0.1, Number(fields.durationSec) || 5)),
      codec: ['h264', 'h265', 'vp9'].includes(fields.codec) ? fields.codec : 'h264',
      crf: clampInt(fields.crf, 0, 51, 20),
      subtitleMode: fields.subtitleMode === 'soft' ? 'soft' : 'burn',
    };
    const id = jm.create(params, files, { projectId, sourceName });
    return { id };
  });

  app.get('/api/jobs', async (req) => {
    const project = req.query.project || undefined;
    const limit = clampInt(req.query.limit, 1, 1000, 100);
    const offset = clampInt(req.query.offset, 0, 1e9, 0);
    return store.listJobs({ project_id: project, limit, offset });
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const mem = jm.get(req.params.id);
    if (mem) return { id: mem.id, status: mem.status, stage: mem.stage, progress: mem.progress, error: mem.error };
    const rec = store.getJob(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    return { id: rec.id, status: rec.status, stage: null, progress: rec.status === 'done' ? 1 : 0, error: rec.error };
  });

  app.delete('/api/jobs/:id', async (req, reply) => {
    const rec = store.getJob(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    const mem = jm.get(rec.id);
    if (mem && mem.status !== 'done' && mem.status !== 'failed') {
      return reply.code(409).send({ error: 'job is active' });
    }
    try { await fsp.rm(path.join(DATA_DIR, rec.id), { recursive: true, force: true }); } catch (_) {}
    store.deleteJob(rec.id);
    return { ok: true };
  });

  app.get('/api/jobs/:id/progress', (req, reply) => {
    const job = jm.get(req.params.id);
    if (!job) {
      // 内存无该任务：可能是历史任务，给终态快照即收尾
      const rec = store.getJob(req.params.id);
      if (!rec) return reply.code(404).send({ error: 'not found' });
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      reply.raw.write(`data: ${JSON.stringify({ status: rec.status, stage: null, progress: rec.status === 'done' ? 1 : 0, error: rec.error })}\n\n`);
      reply.raw.end();
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    const send = (ev) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ status: job.status, stage: job.stage, progress: job.progress, error: job.error });
    if (job.status === 'done' || job.status === 'failed') { reply.raw.end(); return; }
    const off = jm.on(job.id, (ev) => {
      send(ev);
      if (ev.status === 'done' || ev.status === 'failed') { off(); reply.raw.end(); }
    });
    req.raw.on('close', off);
  });

  app.get('/api/jobs/:id/video', async (req, reply) => {
    const rec = store.getJob(req.params.id);
    if (!rec || rec.status !== 'done') return reply.code(404).send({ error: 'not ready' });
    const fp = outputPath(rec.id, rec.output_ext);
    let stat;
    try { stat = await fsp.stat(fp); } catch (_) { return reply.code(404).send({ error: 'file gone' }); }
    const type = rec.output_ext === 'webm' ? 'video/webm' : 'video/mp4';
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', type);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        reply.code(416).header('Content-Range', `bytes */${stat.size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(fp, { start, end }));
    }
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(fp));
  });

  // ---- stats ----
  app.get('/api/stats', async (req, reply) => {
    const by = req.query.by;
    if (by === 'date') return store.statsByDate({});
    if (by === 'project') return store.statsByProject();
    return reply.code(400).send({ error: 'by must be date|project' });
  });
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function sanitize(name) { return path.basename(String(name || 'file')).replace(/[^\w.\-]/g, '_'); }
