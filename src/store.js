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
      const id = crypto.randomUUID();
      db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)')
        .run(id, name, now());
      return db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
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
      const msg = (error instanceof Error) ? error.message : String(error ?? '');
      db.prepare(`UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?`)
        .run(msg, now(), id);
    },

    getJob(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return row ? { ...row, params: JSON.parse(row.params) } : null;
    },
    listJobs({ project_id, limit = 100, offset = 0 } = {}) {
      const rows = project_id
        ? db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
            .all(project_id, limit, offset)
        : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
            .all(limit, offset);
      return rows.map((r) => ({ ...r, params: JSON.parse(r.params) }));
    },
    deleteJob(id) {
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    },

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

    close() { db.close(); },
  };
}
