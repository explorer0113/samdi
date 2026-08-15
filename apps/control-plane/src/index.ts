import { ConfigError, loadServerConfig } from '@samdi/config';
import { createInterpreter } from '@samdi/interpreter';
import { openDb } from './db.js';
import { Pipeline, type ChannelRuntime, type PipelineLog } from './pipeline.js';
import { buildServer } from './server.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';
import { ThreadStore } from './thread-store.js';

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

// 설정의 채널 목록을 DB로 동기화한다 (선언적 채널 등록).
const upsertChannel = db.prepare(
  `INSERT INTO channels (id, label, key) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET label = excluded.label, key = excluded.key`,
);
for (const channel of config.channels) {
  upsertChannel.run(channel.id, channel.label ?? channel.id, channel.key);
}

const store = new TaskStore(db, new SqlitePayloadStore(db));
const threads = new ThreadStore(db);

// 어떤 해석기를 쓸지는 채널 설정이 정한다. 내장 구현 외에는
// createInterpreter의 두 번째 인자로 팩토리를 넘겨 확장한다.
const channels = new Map<string, ChannelRuntime>(
  config.channels.map((channel) => [
    channel.id,
    {
      config: channel,
      label: channel.label ?? channel.id,
      interpreter: createInterpreter(channel.interpreter),
    },
  ]),
);

// 라우트는 파이프라인을, 파이프라인은 서버의 로거를 필요로 한다.
// 로거 참조를 한 단계 늦춰서 순환을 푼다.
let logger: PipelineLog = { info: () => {}, error: () => {} };
const pipeline = new Pipeline(channels, threads, store, {
  info: (o, msg) => logger.info(o, msg),
  error: (o, msg) => logger.error(o, msg),
});
const app = buildServer({ db, store, pipeline, threads, workerKey: config.workerKey });
logger = app.log;

app.log.info(
  {
    config: source ?? '(기본값)',
    dbPath: config.dbPath,
    channels: config.channels.map((c) => `${c.id}:${c.interpreter.mode}`),
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
