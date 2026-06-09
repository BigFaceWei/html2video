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

    close() { db.close(); },
  };
}
