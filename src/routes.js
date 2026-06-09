import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { JobManager } from './jobManager.js';
import { makePipeline } from './pipeline.js';

const BASE = path.join(os.tmpdir(), 'html2video-work');

export async function registerRoutes(app) {
  await fsp.mkdir(BASE, { recursive: true });
  const jm = new JobManager({ baseDir: BASE, pipeline: makePipeline() });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/jobs', async (req, reply) => {
    const files = {}; const fields = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'html') files.html = buf;
        else if (part.fieldname === 'zip') files.zip = buf;
        else if (part.fieldname === 'audio') files.audio = { name: sanitize(part.filename), buffer: buf };
        else if (part.fieldname === 'subtitle') files.subtitle = { name: sanitize(part.filename), buffer: buf };
      } else { fields[part.fieldname] = part.value; }
    }
    if (!files.html && !files.zip) return reply.code(400).send({ error: 'html or zip required' });

    const params = {
      width: clampInt(fields.width, 16, 7680, 1920),
      height: clampInt(fields.height, 16, 4320, 1080),
      fps: clampInt(fields.fps, 1, 120, 30),
      durationSec: Math.min(600, Math.max(0.1, Number(fields.durationSec) || 5)),
      codec: ['h264', 'h265', 'vp9'].includes(fields.codec) ? fields.codec : 'h264',
      crf: clampInt(fields.crf, 0, 51, 20),
      subtitleMode: fields.subtitleMode === 'soft' ? 'soft' : 'burn',
    };
    const id = jm.create(params, files);
    return { id };
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const job = jm.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error };
  });

  app.get('/api/jobs/:id/progress', (req, reply) => {
    const job = jm.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    const send = (ev) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ status: job.status, stage: job.stage, progress: job.progress, error: job.error });
    const off = jm.on(job.id, (ev) => {
      send(ev);
      if (ev.status === 'done' || ev.status === 'failed') { off(); reply.raw.end(); }
    });
    req.raw.on('close', off);
  });

  app.get('/api/jobs/:id/video', (req, reply) => {
    const job = jm.get(req.params.id);
    if (!job || job.status !== 'done') return reply.code(404).send({ error: 'not ready' });
    reply.header('Content-Type', 'video/mp4');
    return reply.send(fs.createReadStream(job.output));
  });
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function sanitize(name) { return path.basename(String(name || 'file')).replace(/[^\w.\-]/g, '_'); }
