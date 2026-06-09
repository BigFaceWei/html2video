import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class JobManager {
  // deps.pipeline(job, report) — report(stage, fraction)
  constructor({ baseDir, pipeline }) {
    this.baseDir = baseDir;
    this.pipeline = pipeline;
    this.jobs = new Map();
    this.queue = [];
    this.running = false;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  create(params, files) {
    const id = crypto.randomUUID();
    const dir = path.join(this.baseDir, id);
    const job = {
      id, params, files, dir,
      inputDir: path.join(dir, 'input'),
      output: path.join(dir, 'output.mp4'),
      status: 'queued', stage: 'queued', progress: 0, error: null,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this._drain();
    return id;
  }

  get(id) { return this.jobs.get(id); }
  on(id, cb) { this.emitter.on(id, cb); return () => this.emitter.off(id, cb); }

  _emit(job) {
    this.emitter.emit(job.id, { status: job.status, stage: job.stage, progress: job.progress, error: job.error });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      try {
        await fs.mkdir(job.inputDir, { recursive: true });
        job.status = 'running'; job.stage = 'preparing'; this._emit(job);
        const report = (stage, fraction) => {
          job.stage = stage; job.progress = Math.max(0, Math.min(1, fraction)); this._emit(job);
        };
        await this.pipeline(job, report);
        // 清理输入，保留 output.mp4 供下载
        try { await fs.rm(job.inputDir, { recursive: true, force: true }); } catch (_) {}
        job.status = 'done'; job.stage = 'done'; job.progress = 1; this._emit(job);
      } catch (e) {
        job.status = 'failed'; job.stage = 'failed'; job.error = String(e.message || e); this._emit(job);
      }
    }
    this.running = false;
  }

  waitFor(id) {
    return new Promise((resolve) => {
      const job = this.jobs.get(id);
      if (job.status === 'done' || job.status === 'failed') return resolve(job);
      const off = this.on(id, (ev) => {
        if (ev.status === 'done' || ev.status === 'failed') { off(); resolve(this.jobs.get(id)); }
      });
    });
  }
}
