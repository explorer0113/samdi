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

CREATE TABLE IF NOT EXISTS context_threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  context_key TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT,
  -- "아직 해석 안 한 이벤트가 있는가"는 시각이 아니라 시퀀스로 판단한다.
  -- 같은 밀리초에 이벤트가 들어오면 타임스탬프 비교로는 놓친다.
  event_seq INTEGER NOT NULL DEFAULT 0,
  interpreted_seq INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT NOT NULL,
  last_interpreted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 같은 채널·키의 열린 스레드는 하나뿐이다. 닫힌 스레드가 있어도 새 스레드를 열 수 있게
-- status='open'인 행만 유니크로 묶는다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_open_key
  ON context_threads(channel_id, context_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_threads_status ON context_threads(status, last_event_at);

CREATE TABLE IF NOT EXISTS thread_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES context_threads(id),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_events_thread ON thread_events(thread_id, received_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  label TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref),
  status TEXT NOT NULL,
  agent TEXT,
  thread_id TEXT,
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
  // 정식 마이그레이션 도구 도입 전의 임시 보정: 구버전 DB에 없는 컬럼 추가
  for (const sql of [
    'ALTER TABLE tasks ADD COLUMN agent TEXT',
    'ALTER TABLE tasks ADD COLUMN thread_id TEXT',
  ]) {
    try {
      db.exec(sql);
    } catch {
      // 이미 있으면 무시
    }
  }
  return db;
}
