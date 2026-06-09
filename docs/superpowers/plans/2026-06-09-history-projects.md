# 转换历史 + Project 分组 + 统计图表 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 html2video 增加持久化转换历史、project 分组、单个/按 project 下载、按日期与按 project 的统计图表，渲染/编码管线零改动。

**Architecture:** 新增 `src/store.js`（`node:sqlite` 封装，单一职责）注入 `JobManager` 与 routes；产物与 sqlite 库落 `DATA_DIR`（默认 `./data`）；`/video` 改为查 store，重启后历史仍可下；前端单页分区（转换/历史/统计），Chart.js 本地引入。

**Tech Stack:** Node 24+，`node:sqlite`（DatabaseSync，免 flag），Fastify 5，adm-zip（已依赖），Chart.js（vendor），`node --test`。

参考 spec：`docs/superpowers/specs/2026-06-09-history-projects-design.md`

---

## 文件结构

- 新建 `src/store.js` — sqlite 存储层（projects/jobs/stats）
- 修改 `src/jobManager.js` — 注入 store，状态转移写库
- 修改 `src/routes.js` — DATA_DIR + store 初始化、projectId 必填、/video 走 store、历史/删除/打包/统计接口
- 修改 `package.json` — engines node>=24
- 修改 `.gitignore` — 加 `data/`
- 新建 `test/store.test.js` — store 纯单测（`:memory:`）
- 修改 `test/api.test.js` — project 必填、历史、重启下载、删除、stats
- 新建 `web/common.js` — `$`、fetch 封装、工具
- 修改 `web/app.js` — 转换区接 project 选择
- 新建 `web/history.js` — 历史区
- 新建 `web/stats.js` — 统计区（Chart.js）
- 新建 `web/vendor/chart.umd.min.js` — Chart.js 本地副本
- 修改 `web/index.html` — project 字段 + 历史/统计分区 + 脚本引入
- 修改 `CLAUDE.md` — 数据流图、Node 基线、新接口、保留策略

---

## Task 1: 基线配置（engines + gitignore）

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`（若无则 Create）

- [ ] **Step 1: package.json 加 engines**

在 `package.json` 顶层（`"private": true,` 之后）加：

```json
  "engines": {
    "node": ">=24"
  },
```

- [ ] **Step 2: .gitignore 加 data/**

确保 `.gitignore` 含以下行（追加，若文件不存在则创建）：

```
node_modules/
data/
```

- [ ] **Step 3: 验证 node:sqlite 可用**

Run: `node -e "const {DatabaseSync}=require('node:sqlite'); console.log(typeof DatabaseSync)"`
Expected: 打印 `function`

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: bump node baseline to 24, ignore data dir"
```

---

## Task 2: store.js — schema + projects CRUD

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/store.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function freshStore() { return createStore(':memory:'); }

test('createProject 幂等且 name 唯一', () => {
  const s = freshStore();
  const a = s.createProject('demo');
  const b = s.createProject('demo');
  assert.equal(a.id, b.id);            // 同名返回现有
  assert.equal(a.name, 'demo');
  assert.ok(a.id && a.created_at);
  s.close();
});

test('listProjects 带 jobCount/doneCount', () => {
  const s = freshStore();
  const p = s.createProject('p1');
  s.insertJob({ id: 'j1', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.insertJob({ id: 'j2', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.markDone('j1', { size_bytes: 100 });
  const list = s.listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].jobCount, 2);
  assert.equal(list[0].doneCount, 1);
  s.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../src/store.js'`

- [ ] **Step 3: 实现 store.js（schema + projects + jobs 写入骨架）**

Create `src/store.js`（本任务先含 projects 全部 + insertJob/markDone，jobs 查询与 stats 在 Task 3/4 补；为让本测试通过需 insertJob/markDone 存在）：

```js
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  params       TEXT NOT NULL,
  source_name  TEXT,
  output_ext   TEXT,
  size_bytes   INTEGER,
  has_audio    INTEGER NOT NULL DEFAULT 0,
  has_subtitle INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
`;

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const now = () => Date.now();

  return {
    db,

    // ---- projects ----
    createProject(name) {
      const existing = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
      if (existing) return existing;
      const id = crypto.randomUUID();
      const created_at = now();
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
        .run(id, name, created_at);
      return { id, name, created_at };
    },
    getProject(id) {
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
    },
    listProjects() {
      return db.prepare(`
        SELECT p.id, p.name, p.created_at,
          COUNT(j.id) AS jobCount,
          COALESCE(SUM(CASE WHEN j.status='done' THEN 1 ELSE 0 END), 0) AS doneCount
        FROM projects p LEFT JOIN jobs j ON j.project_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `).all();
    },
    deleteProject(id) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    },

    // ---- jobs ----
    insertJob({ id, project_id, params, source_name, output_ext, has_audio, has_subtitle }) {
      db.prepare(`
        INSERT INTO jobs (id, project_id, status, params, source_name, output_ext, has_audio, has_subtitle, created_at)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        id, project_id, JSON.stringify(params),
        source_name ?? null, output_ext ?? null,
        has_audio ? 1 : 0, has_subtitle ? 1 : 0, now()
      );
    },
    markDone(id, { size_bytes } = {}) {
      db.prepare(`UPDATE jobs SET status='done', size_bytes=?, finished_at=? WHERE id=?`)
        .run(size_bytes ?? null, now(), id);
    },
    markFailed(id, error) {
      db.prepare(`UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?`)
        .run(String(error ?? ''), now(), id);
    },

    close() { db.close(); },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: store.js with projects CRUD and job insert/markers"
```

---

## Task 3: store.js — jobs 查询

**Files:**
- Modify: `src/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: 追加失败测试**

在 `test/store.test.js` 末尾追加：

```js
test('getJob 反序列化 params，listJobs 按 project 过滤倒序', () => {
  const s = freshStore();
  const p = s.createProject('p');
  s.insertJob({ id: 'a', project_id: p.id, params: { codec: 'vp9', fps: 30 }, output_ext: 'webm' });
  s.insertJob({ id: 'b', project_id: p.id, params: { codec: 'h264', fps: 24 }, output_ext: 'mp4' });
  const job = s.getJob('a');
  assert.equal(job.params.codec, 'vp9');     // params 已 JSON.parse
  assert.equal(job.output_ext, 'webm');
  assert.equal(job.status, 'queued');
  const all = s.listJobs({ project_id: p.id });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'b');              // created_at 倒序，后插的在前
  assert.equal(s.getJob('missing'), null);
  s.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL — `s.getJob is not a function`

- [ ] **Step 3: 实现 getJob / listJobs / deleteJob**

在 `src/store.js` 的 `markFailed(...)` 与 `close()` 之间插入：

```js
    getJob(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return row ? { ...row, params: JSON.parse(row.params) } : null;
    },
    listJobs({ project_id, limit = 100, offset = 0 } = {}) {
      const rows = project_id
        ? db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
            .all(project_id, limit, offset)
        : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?')
            .all(limit, offset);
      return rows.map((r) => ({ ...r, params: JSON.parse(r.params) }));
    },
    deleteJob(id) {
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: store getJob/listJobs/deleteJob"
```

---

## Task 4: store.js — 统计聚合

**Files:**
- Modify: `src/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: 追加失败测试**

在 `test/store.test.js` 末尾追加：

```js
test('statsByProject 含成功失败计数、字节、codec 分布', () => {
  const s = freshStore();
  const p = s.createProject('proj');
  s.insertJob({ id: 'x', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.insertJob({ id: 'y', project_id: p.id, params: { codec: 'vp9' }, output_ext: 'webm' });
  s.markDone('x', { size_bytes: 500 });
  s.markFailed('y', 'boom');
  const st = s.statsByProject();
  const row = st.find((r) => r.project_id === p.id);
  assert.equal(row.total, 2);
  assert.equal(row.done, 1);
  assert.equal(row.failed, 1);
  assert.equal(row.bytes, 500);
  assert.equal(row.codecBreakdown.h264, 1);
  assert.equal(row.codecBreakdown.vp9, 1);
  s.close();
});

test('statsByDate 按天聚合', () => {
  const s = freshStore();
  const p = s.createProject('proj');
  s.insertJob({ id: 'd1', project_id: p.id, params: { codec: 'h264' }, output_ext: 'mp4' });
  s.markDone('d1', { size_bytes: 10 });
  const rows = s.statsByDate();
  assert.equal(rows.length, 1);
  assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rows[0].total, 1);
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].bytes, 10);
  s.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL — `s.statsByProject is not a function`

- [ ] **Step 3: 实现 statsByDate / statsByProject**

在 `src/store.js` 的 `deleteJob(...)` 之后插入：

```js
    statsByDate({ from, to } = {}) {
      // created_at 为 epoch ms；/1000 转秒后用 unixepoch 取日期
      return db.prepare(`
        SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day,
          COUNT(*) AS total,
          SUM(CASE WHEN status='done'   THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
          COALESCE(SUM(size_bytes), 0) AS bytes
        FROM jobs
        WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
        GROUP BY day
        ORDER BY day
      `).all(from ?? null, from ?? null, to ?? null, to ?? null);
    },
    statsByProject() {
      const rows = db.prepare(`
        SELECT p.id AS project_id, p.name AS name,
          COUNT(j.id) AS total,
          COALESCE(SUM(CASE WHEN j.status='done'   THEN 1 ELSE 0 END), 0) AS done,
          COALESCE(SUM(CASE WHEN j.status='failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(j.size_bytes), 0) AS bytes
        FROM projects p LEFT JOIN jobs j ON j.project_id = p.id
        GROUP BY p.id
        ORDER BY total DESC
      `).all();
      const codecs = db.prepare(`
        SELECT project_id, json_extract(params, '$.codec') AS codec, COUNT(*) AS n
        FROM jobs GROUP BY project_id, codec
      `).all();
      const map = {};
      for (const c of codecs) {
        (map[c.project_id] ??= {})[c.codec] = c.n;
      }
      return rows.map((r) => ({ ...r, codecBreakdown: map[r.project_id] || {} }));
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: store statsByDate/statsByProject aggregations"
```

---

## Task 5: jobManager 注入 store + 状态写库

**Files:**
- Modify: `src/jobManager.js`

- [ ] **Step 1: 替换 jobManager.js 全文**

Replace `src/jobManager.js` 全部内容为：

```js
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
    this.jobs.set(id, job);
    if (this.store && job.projectId) {
      this.store.insertJob({
        id, project_id: job.projectId, params,
        source_name: meta.sourceName || null, output_ext: ext,
        has_audio: !!(files && files.audio), has_subtitle: !!(files && files.subtitle),
      });
    }
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
```

- [ ] **Step 2: 运行回归（确认未破坏现有 jobManager 行为）**

Run: `node --test test/jobManager.test.js`
Expected: PASS（若该文件存在；若用 `meta` 参数旧调用 `create(params, files)` 仍兼容——meta 默认 `{}`）

注：若仓库无 `test/jobManager.test.js`，跳过，靠 Task 10 的 api 集成测试覆盖。

- [ ] **Step 3: Commit**

```bash
git add src/jobManager.js
git commit -m "feat: jobManager writes job lifecycle to store"
```

---

## Task 6: routes — DATA_DIR + store 初始化 + projectId 必填 + /video 走 store

**Files:**
- Modify: `src/routes.js`

- [ ] **Step 1: 替换 routes.js 全文**

Replace `src/routes.js` 全部内容为（含本任务改动 + 后续任务新接口；新接口实现一次到位）：

```js
import os from 'node:os';
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
    const safe = p.name.replace(/[^\w.\-]/g, '_');
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${safe}.zip"`);
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
    return { id: rec.id, status: rec.status, stage: rec.status, progress: rec.status === 'done' ? 1 : 0, error: rec.error };
  });

  app.delete('/api/jobs/:id', async (req, reply) => {
    const rec = store.getJob(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
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
      reply.raw.write(`data: ${JSON.stringify({ status: rec.status, stage: rec.status, progress: rec.status === 'done' ? 1 : 0, error: rec.error })}\n\n`);
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
```

注：`os` import 保留以防其他引用；若 lint 报未用可删去 `import os`。本文件不再用 tmpdir。

- [ ] **Step 2: 冒烟——服务可起且 health OK**

Run: `DATA_DIR=$(mktemp -d) node -e "import('./server.js').then(async m=>{const a=m.buildServer();await a.listen({port:0,host:'127.0.0.1'});const p=a.server.address().port;const r=await fetch('http://127.0.0.1:'+p+'/api/health');console.log(await r.json());await a.close()})"`
Expected: 打印 `{ ok: true }`，无报错

- [ ] **Step 3: Commit**

```bash
git add src/routes.js
git commit -m "feat: routes data dir, store init, projectId required, history/stats/download endpoints"
```

---

## Task 7: api 集成测试 — project 必填、历史、重启下载、删除、stats

**Files:**
- Modify: `test/api.test.js`

- [ ] **Step 1: 在现有 e2e 测试前设置临时 DATA_DIR，并追加新测试**

在 `test/api.test.js` 顶部 import 之后插入（让全文件共享一个临时 data 目录）：

```js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-test-'));
```

并把现有 e2e 测试中提交 job 的表单加上 projectId（先建 project）。在该测试 `const form = new FormData();` 之前插入：

```js
    const pr = await (await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e' }),
    })).json();
    assert.ok(pr.id);
```

并在 `form.append('crf','28');` 之后加：

```js
    form.append('projectId', pr.id);
```

- [ ] **Step 2: 追加「project 必填」测试**

在 `test/api.test.js` 末尾追加：

```js
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
```

- [ ] **Step 3: 追加「重启后历史仍可下载 + 历史列表 + 删除」测试**

在 `test/api.test.js` 末尾追加：

```js
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
```

- [ ] **Step 4: 运行全部集成测试**

Run: `node --test --test-timeout=120000 test/api.test.js`
Expected: PASS（3 tests：原 e2e + 400 + 重启）

- [ ] **Step 5: Commit**

```bash
git add test/api.test.js
git commit -m "test: projectId required, history, restart download, delete, stats"
```

---

## Task 8: 前端 — common.js + index.html 引入 + project 选择字段

**Files:**
- Create: `web/common.js`
- Modify: `web/index.html`
- Modify: `web/app.js`

- [ ] **Step 1: 新建 common.js**

Create `web/common.js`:

```js
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
```

- [ ] **Step 2: index.html 表单加 project 字段**

在 `web/index.html` 中，找到第一个表单字段（`<div class="field">` 包着 `HTML 文件...`）的**前面**插入 project 选择字段。具体：把

```html
  <form id="form" class="card">
    <div class="field">
      <label>HTML 文件（单个 .html）或 ZIP 包（含 index.html）</label>
```

替换为

```html
  <form id="form" class="card">
    <div class="field">
      <label>Project（必选）</label>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="margin-bottom:0"><select id="projectSel"></select></div>
        <div class="field" style="margin-bottom:0;flex:0 0 auto">
          <input type="text" id="newProject" placeholder="或输入新 project 名" style="min-width:180px">
        </div>
      </div>
    </div>
    <div class="field">
      <label>HTML 文件（单个 .html）或 ZIP 包（含 index.html）</label>
```

- [ ] **Step 3: index.html 末尾改脚本引入为 ESM**

把 `web/index.html` 的

```html
<script src="/app.js"></script>
```

替换为

```html
<script type="module" src="/app.js"></script>
```

- [ ] **Step 4: 改写 app.js 接 project（保留转换流程）**

Replace `web/app.js` 全部内容为：

```js
import { $, api } from './common.js';

const STAGE = { preparing: '准备中', rendering: '渲染帧', encoding: '编码中', done: '完成', failed: '失败' };

export async function loadProjects(selectedId) {
  const projects = await api.listProjects().catch(() => []);
  const sel = $('projectSel');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.name}（${p.jobCount}）`;
    sel.append(o);
  }
  if (selectedId) sel.value = selectedId;
  return projects;
}

async function resolveProjectId() {
  const name = $('newProject').value.trim();
  if (name) {
    const p = await api.createProject(name);
    $('newProject').value = '';
    await loadProjects(p.id);
    return p.id;
  }
  return $('projectSel').value || null;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = ''; $('preview').style.display = 'none'; $('download').style.display = 'none';
  const src = $('source').files[0];
  if (!src) return;

  let projectId;
  try { projectId = await resolveProjectId(); } catch (err) { $('err').textContent = '创建 project 失败：' + err.message; return; }
  if (!projectId) { $('err').textContent = '请先选择或新建一个 project'; return; }

  const fd = new FormData();
  const isZip = /\.zip$/i.test(src.name);
  fd.append(isZip ? 'zip' : 'html', src, src.name);
  fd.append('projectId', projectId);
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
      window.dispatchEvent(new CustomEvent('job-done'));   // 通知历史/统计刷新
      loadProjects(projectId);
    }
  };
  es.onerror = () => { es.close(); };
});

loadProjects();
```

- [ ] **Step 5: 手动验证**

Run: `npm start`（另开终端），浏览器开 http://127.0.0.1:3000
Expected: project 下拉可见；输入新 project 名 + 上传 html 提交后转换成功、预览出现；下拉数字 +1。

- [ ] **Step 6: Commit**

```bash
git add web/common.js web/app.js web/index.html
git commit -m "feat(web): project select in convert form, common.js utils"
```

---

## Task 9: 前端 — 历史区

**Files:**
- Modify: `web/index.html`
- Create: `web/history.js`

- [ ] **Step 1: index.html 加历史分区 + CSS**

在 `web/index.html` 中，找到

```html
  <video id="preview" controls></video>
  <a id="download">下载视频</a>
</div>
```

替换为

```html
  <video id="preview" controls></video>
  <a id="download">下载视频</a>

  <section id="historySec" class="card" style="margin-top:32px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0">转换历史</h2>
      <div style="display:flex;gap:10px;align-items:center">
        <select id="histFilter"></select>
        <a id="histZip" style="display:none" class="hist-btn">⤓ 打包下载</a>
      </div>
    </div>
    <div id="histList"></div>
  </section>
</div>
```

并在 `</style>` 之前追加 CSS：

```css
  #historySec h2,#statsSec h2{color:var(--text)}
  .hist-row{display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:center;
    padding:12px 0;border-bottom:1px solid var(--line-2)}
  .hist-row:last-child{border-bottom:0}
  .hist-meta{font-size:13px;color:var(--text-2)}
  .hist-title{font-size:15px;font-weight:560}
  .badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:980px}
  .badge.done{background:rgba(48,209,88,.15);color:#248a3d}
  .badge.failed{background:rgba(255,69,58,.15);color:var(--danger)}
  .badge.queued,.badge.running{background:rgba(0,113,227,.12);color:var(--accent)}
  .hist-btn{font-size:13px;font-weight:560;color:var(--accent);text-decoration:none;cursor:pointer;
    border:1px solid var(--line);border-radius:980px;padding:5px 12px}
  .hist-btn:hover{background:rgba(0,113,227,.06)}
  .hist-btn.danger{color:var(--danger)}
  .hist-actions{display:flex;gap:8px}
```

- [ ] **Step 2: 新建 history.js**

Create `web/history.js`:

```js
import { $, api, fmtBytes, fmtTime } from './common.js';

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
    left.innerHTML =
      `<div class="hist-title">${byId[j.project_id] || '—'} · ${(p.codec || '').toUpperCase()} `
      + `<span class="badge ${j.status}">${STATUS_CN[j.status] || j.status}</span></div>`
      + `<div class="hist-meta">${fmtTime(j.created_at)} · ${p.width}×${p.height} @${p.fps}fps · ${fmtBytes(j.size_bytes)}</div>`;
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
```

- [ ] **Step 3: index.html 引入 history.js**

在 `web/index.html` 的 `<script type="module" src="/app.js"></script>` 之后加：

```html
<script type="module" src="/history.js"></script>
```

- [ ] **Step 4: 手动验证**

Run: `npm start`，浏览器刷新
Expected: 历史区列出已转换记录；过滤下拉切换 project 列表变化并出现「打包下载」；删除后行消失。

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/history.js
git commit -m "feat(web): conversion history section with filter, download, delete"
```

---

## Task 10: 前端 — 统计区（Chart.js）

**Files:**
- Create: `web/vendor/chart.umd.min.js`
- Modify: `web/index.html`
- Create: `web/stats.js`

- [ ] **Step 1: 下载 Chart.js 到 vendor**

Run:
```bash
mkdir -p web/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js -o web/vendor/chart.umd.min.js
test -s web/vendor/chart.umd.min.js && echo OK
```
Expected: 打印 `OK`（文件非空）

- [ ] **Step 2: index.html 加统计分区 + 引入 Chart.js（非 module，挂全局 window.Chart）**

在 `web/index.html` 中，找到 `</section>`（历史区结束）后紧接的 `</div>`，把

```html
    <div id="histList"></div>
  </section>
</div>
```

替换为

```html
    <div id="histList"></div>
  </section>

  <section id="statsSec" class="card" style="margin-top:32px">
    <h2 style="font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0 0 20px">统计</h2>
    <h3 style="font-size:15px;color:var(--text-2);margin:0 0 8px">按日期</h3>
    <canvas id="chartDate" height="120"></canvas>
    <h3 style="font-size:15px;color:var(--text-2);margin:24px 0 8px">按 Project（转换数）</h3>
    <canvas id="chartProject" height="120"></canvas>
    <h3 style="font-size:15px;color:var(--text-2);margin:24px 0 8px">编码分布</h3>
    <canvas id="chartCodec" height="120"></canvas>
  </section>
</div>
```

并在 `<script type="module" src="/app.js"></script>` **之前**加 Chart.js：

```html
<script src="/vendor/chart.umd.min.js"></script>
```

并在 `<script type="module" src="/history.js"></script>` 之后加：

```html
<script type="module" src="/stats.js"></script>
```

- [ ] **Step 3: 新建 stats.js**

Create `web/stats.js`:

```js
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
```

- [ ] **Step 4: 手动验证**

Run: `npm start`，浏览器刷新
Expected: 三张图渲染（按日期堆叠柱、按 project 柱、编码饼）；完成一次新转换后图自动刷新。

- [ ] **Step 5: Commit**

```bash
git add web/vendor/chart.umd.min.js web/index.html web/stats.js
git commit -m "feat(web): stats section with Chart.js (by date, by project, codec)"
```

---

## Task 11: 文档同步

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md**

在 `CLAUDE.md` 做以下改动：

1. 顶部「What this is」段把 `Node 20+` 改为 `Node 24+`，并在依赖句尾加：`持久化用 node:sqlite（内置）。`
2. 「Architecture」数据流图替换为：

```
HTTP 上传 → routes → store.insertJob(queued) → JobManager(串行队列) → pipeline → [assets → renderer → encoder]
                          │                                                              │
                          ├ SSE 进度推送                                                  ▼
                          └ 终态 → store.markDone/markFailed                    DATA_DIR/<id>/output.mp4|webm（持久）

历史/统计/下载：routes → store 查询 → 读 DATA_DIR 产物
```

3. 在模块列表加一条：

```
- **`src/store.js`** — node:sqlite 持久层。projects/jobs 两表，CRUD + 按日期/按 project 聚合。注入 JobManager 与 routes，测试用 `:memory:`。
```

4. 「关键约束与陷阱」加三条：

```
- **产物持久在 `DATA_DIR`（默认 `./data`，env 可覆盖）**：不再用 tmpdir。`/video` 路由查 store 取产物路径，重启后历史仍可下载——勿改回依赖内存 Map。
- **project 必填**：`POST /api/jobs` 须带存在的 `projectId`，否则 400。`jobs.project_id NOT NULL`，删 project 级联删 jobs 行（产物文件由路由另删）。
- **保留策略**：产物不自动清理，仅手动删除接口。`RETENTION_MAX` 为预留 TODO，未实现自动清理——加自动清理前先确认需求。
```

5. 「Commands」段补一行运行依赖说明：`需 Node 24+（node:sqlite 免 flag）。`

- [ ] **Step 2: 跑全套测试确认无回归**

Run: `npm test`（涉及浏览器/ffmpeg 的用例需较长时间）或至少：
```bash
node --test test/store.test.js
node --test --test-timeout=120000 test/api.test.js
```
Expected: 全 PASS

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for persistence, projects, stats"
```

---

## 收尾验证清单

- [ ] `node --test test/store.test.js` 全绿
- [ ] `node --test --test-timeout=120000 test/api.test.js` 全绿
- [ ] `npm start` 后浏览器：建 project → 转换 → 历史出现 → 单个下载 → 切 project 过滤 → 打包下载 → 三张统计图 → 删除记录
- [ ] 重启 `npm start`（同 `./data`）后历史视频仍可下载
- [ ] `git status` 干净，`data/` 未被跟踪
