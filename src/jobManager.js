import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class JobManager {
  // deps.pipeline(job, report) — report(stage, fraction)
  // deps.store — createStore(...) 返回的实例（可选；测试可不传）
  constructor({ baseDir, pipeline, store = null }) {
    this.baseDir = baseDir;
    this.pipeline = pipeline;
    this.store = store;
    this.jobs = new Map();
    this.queue = [];
    this.running = false;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  // meta: { projectId, sourceName }
  create(params, files, meta = {}) {
    const id = crypto.randomUUID();
    const dir = path.join(this.baseDir, id);
    const ext = params && params.codec === 'vp9' ? 'webm' : 'mp4';
    const job = {
      id, params, files, dir,
      projectId: meta.projectId || null,
      inputDir: path.join(dir, 'input'),
      output: path.join(dir, `output.${ext}`),
      status: 'queued', stage: 'queued', progress: 0, error: null,
    };
    if (this.store && job.projectId) {
      this.store.insertJob({
        id, project_id: job.projectId, params,
        source_name: meta.sourceName || null, output_ext: ext,
        has_audio: !!(files && files.audio), has_subtitle: !!(files && files.subtitle),
      });
    }
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
        // 清理输入，保留 output 供下载
        try { await fs.rm(job.inputDir, { recursive: true, force: true }); } catch (_) {}
        let size = null;
        try { size = (await fs.stat(job.output)).size; } catch (_) {}
        if (this.store && job.projectId) {
          try { this.store.markDone(id, { size_bytes: size }); } catch (_) {}
        }
        job.status = 'done'; job.stage = 'done'; job.progress = 1; this._emit(job);
      } catch (e) {
        // 失败时清理整个工作目录（无可用产物）
        try { await fs.rm(job.dir, { recursive: true, force: true }); } catch (_) {}
        const msg = String(e.message || e);
        if (this.store && job.projectId) {
          try { this.store.markFailed(id, msg); } catch (_) {}
        }
        job.status = 'failed'; job.stage = 'failed'; job.error = msg; this._emit(job);
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
