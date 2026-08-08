import { ConfigError, loadServerConfig } from '@samdi/config';
import { openDb } from './db.js';
import { buildServer } from './server.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';

/**
 * Control Plane — 순수 상태 관리자. LLM을 호출하지 않는다.
 *
 * 설정: samdi.server.yaml (탐색 순서와 키는 docs/configuration.md 참조).
 * 설정 파일이 없어도 기본값으로 동작하고, 환경변수가 파일을 덮는다.
 */
let loaded;
try {
  loaded = loadServerConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const { config, source } = loaded;

const db = openDb(config.dbPath);

// 설정의 채널 목록을 DB로 동기화한다 (선언적 채널 등록).
const upsertChannel = db.prepare(
  `INSERT INTO channels (id, label, key) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET label = excluded.label, key = excluded.key`,
);
for (const channel of config.channels) {
  upsertChannel.run(channel.id, channel.label ?? channel.id, channel.key);
}

const store = new TaskStore(db, new SqlitePayloadStore(db));
const app = buildServer({ db, store, workerKey: config.workerKey });

app.log.info(
  {
    config: source ?? '(기본값)',
    dbPath: config.dbPath,
    channels: config.channels.map((c) => c.id),
  },
  'control plane 설정 로드',
);

// lease 만료 스캔 → stalled (자동 재배포 없음)
setInterval(() => {
  const n = store.sweepExpiredLeases();
  if (n > 0) app.log.info({ stalled: n }, 'lease expired tasks moved to stalled');
}, config.sweepIntervalMs).unref();

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
