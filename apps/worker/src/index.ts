import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ConfigError, loadWorkerConfig } from '@samdi/config';
import { localReportSchema } from '@samdi/protocol';
import { ClaudeCodeAdapter, MockAgentAdapter, type AgentAdapter } from '@samdi/agent-adapter';
import { ApprovalStartGate } from '@samdi/policy-gateway';
import { ActivityLog } from './activity-log.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { LabelStore } from './labels.js';
import { Worker } from './worker.js';

/**
 * Worker 데몬 — 사용자 기기에서 돈다.
 * 흐름: claim → Start Gate → 어댑터 실행 → 로컬 보고 수신 → 결과 중계.
 * 해석·분류는 서버가 끝냈으므로 여기서 LLM을 쓰지 않는다.
 *
 * 설정: samdi.worker.yaml (탐색 순서와 키는 docs/configuration.md 참조).
 * 설정 파일이 없어도 기본값으로 동작하고, 환경변수가 파일을 덮는다.
 *
 * 로컬 API 두 종류를 연다 (둘 다 루프백 전용):
 *  - /report/:taskId  에이전트 → Worker 보고 (유일한 역방향 채널)
 *  - /ui/*            worker-ui 대시보드용. 브라우저에 키를 노출하지 않도록
 *                     Worker가 자기 키로 Control Plane을 프록시한다.
 */
let loaded;
try {
  loaded = loadWorkerConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const { config, source } = loaded;

const controlPlaneUrl = config.controlPlane.url;
const {
  id: workerId,
  labels: configuredLabels,
  pollIntervalMs,
  leaseSeconds,
  reportPort,
  reportHost,
  concurrency,
} = config.worker;
const defaultAgent = config.defaultAgent;

// 어떤 라벨의 일을 받을지는 이 기기의 결정이다 — 화면에서 바꿀 수 있고,
// 설정 파일 값은 기준값으로 남아 언제든 되돌릴 수 있다.
const labelStore = new LabelStore(configuredLabels);

const app = Fastify({ logger: true });
const activity = new ActivityLog();
const client = new ControlPlaneClient(controlPlaneUrl, config.controlPlane.workerKey);

/** UI 드롭다운에서 Task별로 고를 수 있는 어댑터 레지스트리 */
const adapters: Record<string, AgentAdapter> = {
  mock: new MockAgentAdapter(),
  // Terminal 창을 띄워 사용자가 진행 과정을 보고 개입할 수 있게 한다 (macOS)
  'claude-code': new ClaudeCodeAdapter(config.agents['claude-code']),
};

const worker = new Worker({
  client,
  gate: new ApprovalStartGate(config.startGate),
  adapters,
  defaultAgent,
  activity,
  workerId,
  labels: () => labelStore.get(),
  leaseSeconds,
  reportBaseUrl: `http://127.0.0.1:${reportPort}`,
  log: app.log,
});

/**
 * 로컬 보고 API — 에이전트 → Worker 방향의 유일한 채널.
 * ask 보고는 사용자가 승인/거부를 결정할 때까지 응답이 보류되고,
 * 응답 본문으로 { decision: 'approve' | 'deny' }가 돌아간다.
 */
app.post('/report/:taskId', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const parsed = localReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid report', issues: parsed.error.issues });
  }
  const result = worker.handleLocalReport(taskId, parsed.data);
  if (!result.ok) {
    return reply.code(404).send({ error: `no task in progress: ${taskId}` });
  }
  if (result.decision) {
    return { decision: await result.decision };
  }
  return { ok: true };
});

/**
 * 이 Worker가 받을 라벨을 바꾼다. 다음 claim부터 적용된다 — 재시작이 필요 없다.
 * 채널은 운영 중에 생기므로, 새 채널의 일을 받으려고 매번 재시작할 수는 없다.
 */
app.post('/ui/labels', async (req, reply) => {
  const { labels: next, reset } = (req.body ?? {}) as { labels?: unknown; reset?: boolean };
  try {
    if (reset) return { labels: labelStore.reset(), overridden: false };
    if (!Array.isArray(next) || next.some((l) => typeof l !== 'string')) {
      return reply.code(400).send({ error: 'labels는 문자열 배열이어야 한다' });
    }
    const applied = labelStore.set(next as string[]);
    activity.push('labels:changed', undefined, applied.join(', '));
    return { labels: applied, overridden: labelStore.overridden };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** worker-ui용 로컬 API */
app.get('/ui/state', async () => ({
  workerId,
  labels: labelStore.get(),
  configuredLabels: labelStore.configured,
  labelsOverridden: labelStore.overridden,
  controlPlaneUrl,
  current: worker.current,
  approvals: worker.approvals,
  concurrency,
  activity: activity.list(),
}));

/** 승인 대기 중인 ask에 대한 사용자 결정. */
app.post('/ui/tasks/:taskId/approve', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const { decision } = (req.body ?? {}) as { decision?: string };
  if (decision !== 'approve' && decision !== 'deny') {
    return reply.code(400).send({ error: 'decision must be approve or deny' });
  }
  if (!worker.decide(taskId, decision)) {
    return reply.code(404).send({ error: `no pending approval: ${taskId}` });
  }
  activity.push(`manual:${decision}`, taskId);
  return { ok: true };
});

app.get('/ui/agents', async () => ({
  agents: Object.keys(adapters),
  default: defaultAgent,
}));

/** UI 폴링 경로. 기본은 진행 중인 Task만 (종결분은 view=all로 명시해야 온다). */
app.get('/ui/tasks', async (req) => {
  const { view, limit } = req.query as { view?: 'active' | 'all'; limit?: string };
  return client.listTasks({ view, limit: limit ? Number(limit) : undefined });
});

/** 처리할 에이전트 지정 (pending 동안만) */
app.post('/ui/tasks/:taskId/agent', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const { agent } = (req.body ?? {}) as { agent?: string };
  if (!agent || !adapters[agent]) {
    return reply.code(400).send({ error: `unknown agent: ${agent}` });
  }
  const out = await client.setAgent(taskId, agent);
  activity.push('agent:assigned', taskId, agent);
  return out;
});

app.get('/ui/tasks/:taskId', async (req) => {
  const { taskId } = req.params as { taskId: string };
  return client.getTask(taskId);
});

/** stalled 수동 게이트 — 사용자 결정은 사용자 기기에서 내린다. */
app.post('/ui/tasks/:taskId/resolve', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const { action } = (req.body ?? {}) as { action?: string };
  if (action !== 'retry' && action !== 'abandon') {
    return reply.code(400).send({ error: 'action must be retry or abandon' });
  }
  const out = await client.resolveStalled(taskId, action);
  activity.push(`manual:${action}`, taskId);
  return out;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

async function main() {
  // 빌드된 UI를 같은 출처로 내보낸다 (설정된 경우에만).
  // 개발 중에는 vite 개발 서버가 /ui를 여기로 프록시하므로 이 경로는 비어 있다.
  // 명시 라우트(/ui/*, /report/*)가 정적 와일드카드보다 우선한다.
  if (config.uiDist) {
    if (!existsSync(config.uiDist)) {
      app.log.error({ uiDist: config.uiDist }, 'uiDist 경로가 없다 — UI를 서빙하지 않는다');
    } else {
      await app.register(fastifyStatic, { root: config.uiDist });
      app.log.info({ uiDist: config.uiDist }, 'serving worker-ui');
    }
  }

  await app.listen({ port: reportPort, host: reportHost });

  // 이전 실행이 물고 있던 Task를 정리한다. 재시작하면 에이전트도 승인 대기도
  // 사라지므로, 그대로 두면 waiting에 멈춘 채 승인 버튼도 없는 상태가 된다.
  try {
    const { recovered } = await client.recover(workerId);
    if (recovered.length > 0) {
      activity.push('recovered', undefined, `${recovered.length}건을 stalled로 되돌림`);
      app.log.warn(
        { workerId, recovered: recovered.length },
        'previous run left tasks in flight; moved to stalled for manual retry',
      );
    }
  } catch (err) {
    app.log.error({ err: String(err) }, 'startup recovery failed');
  }

  app.log.info(
    {
      config: source ?? '(기본값)',
      controlPlaneUrl,
      workerId,
      labels: labelStore.get(),
      defaultAgent,
      listen: `${reportHost}:${reportPort}`,
      concurrency,
      requireApproval: config.startGate.requireApproval,
    },
    'worker started, polling',
  );

  // concurrency만큼 독립적인 루프를 돌린다. claim은 서버에서 원자적이라
  // 같은 Task를 둘이 집는 일은 없다. 사람을 기다리는 Task가 있어도
  // 다른 루프가 계속 다음 일을 집는다.
  const loop = async () => {
    while (!stopping) {
      let processed = false;
      try {
        processed = await worker.processOne();
      } catch (err) {
        app.log.error({ err: String(err) }, 'poll iteration failed');
      }
      if (!processed) await sleep(pollIntervalMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, loop));
  await app.close();
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
