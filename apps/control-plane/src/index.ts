import { ConfigError, loadServerConfig } from '@samdi/config';
import { ChannelRegistry } from './channel-registry.js';
import { openDb } from './db.js';
import { Pipeline, type PipelineLog } from './pipeline.js';
import { buildServer } from './server.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';
import { ThreadStore } from './thread-store.js';
import { WorkerRegistry } from './worker-registry.js';

/**
 * Control Plane — 수집기 → 해석기 → 분배기.
 *
 * 해석 LLM은 여기서만, 이벤트당 한 번만 돈다. 실행 판단과 자격 증명은 Worker의 것이다.
 * 채널이 passthrough 모드면 LLM을 전혀 쓰지 않고 이벤트가 곧 Task가 된다.
 *
 * 설정: samdi.server.yaml (탐색 순서와 키는 docs/configuration.md 참조).
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

const store = new TaskStore(db, new SqlitePayloadStore(db));
const threads = new ThreadStore(db);

// 채널의 진실은 DB다. 설정 파일에 적은 채널은 시작할 때마다 파일 내용으로 덮어쓰고,
// 관리 화면에서 만든 채널은 DB에만 있다가 여기서 같이 실려온다.
const channels = new ChannelRegistry(db);
channels.syncFromConfig(config.channels);
channels.load();

// Worker는 claim할 때마다 자기 라벨을 알려온다 — 그걸 받아 적는 게 등록을 대신한다.
const workers = new WorkerRegistry(db);

// 라우트는 파이프라인을, 파이프라인은 서버의 로거를 필요로 한다.
// 로거 참조를 한 단계 늦춰서 순환을 푼다.
let logger: PipelineLog = { info: () => {}, error: () => {} };
const pipeline = new Pipeline(channels, threads, store, {
  info: (o, msg) => logger.info(o, msg),
  error: (o, msg) => logger.error(o, msg),
});
const app = buildServer({
  db,
  store,
  pipeline,
  threads,
  channels,
  workers,
  workerKey: config.workerKey,
  adminKey: config.adminKey,
  uiDist: config.uiDist,
});
logger = app.log;

app.log.info(
  {
    config: source ?? '(기본값)',
    dbPath: config.dbPath,
    channels: channels.list().map((c) => `${c.id}:${c.interpreter.mode}(${c.source})`),
  },
  'control plane 설정 로드',
);

// lease 만료 스캔(stalled) + 문맥 스레드 TTL 만료·밀린 해석 실행
setInterval(() => {
  const n = store.sweepExpiredLeases();
  if (n > 0) app.log.info({ stalled: n }, 'lease expired tasks moved to stalled');
  void pipeline.sweep().catch((err) => app.log.error({ err: String(err) }, 'pipeline sweep failed'));
}, config.sweepIntervalMs).unref();

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
