import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * MVP 스키마. 본문(payloads)은 Task 상태 테이블과 분리한다 (SOP: PayloadStore 분리).
 * Drizzle 도입은 스키마가 안정화된 뒤 검토한다.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payloads (
  ref TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  label TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref),
  status TEXT NOT NULL,
  agent TEXT,
  worker_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_label ON tasks(status, label);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, at);
`);
  // 정식 마이그레이션 도구 도입 전의 임시 보정: 구버전 DB에 agent 컬럼 추가
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN agent TEXT');
  } catch {
    // 이미 있으면 무시
  }
  return db;
}
