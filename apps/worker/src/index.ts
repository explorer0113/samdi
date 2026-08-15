import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ConfigError, loadWorkerConfig } from '@samdi/config';
import { localReportSchema } from '@samdi/protocol';
import { ClaudeCodeAdapter, MockAgentAdapter, type AgentAdapter } from '@samdi/agent-adapter';
import { ApprovalStartGate } from '@samdi/policy-gateway';
import { ActivityLog } from './activity-log.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { WorkerState } from './worker-state.js';
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
  concurrency: configuredConcurrency,
} = config.worker;
const defaultAgent = config.defaultAgent;

// 무슨 일을 받을지(labels)와 한 번에 몇 건을 감당할지(concurrency)는 이 기기의
// 결정이다 — 화면에서 바꿀 수 있고, 설정 파일 값은 기준값으로 남는다.
const state = new WorkerState({
  labels: configuredLabels,
  concurrency: configuredConcurrency,
  defaultAgent,
});

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
  defaultAgent: () => state.defaultAgent,
  activity,
  workerId,
  labels: () => state.labels,
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
    if (reset) {
      state.reset();
      applyConcurrency();
    } else {
      if (!Array.isArray(next) || next.some((l) => typeof l !== 'string')) {
        return reply.code(400).send({ error: 'labels는 문자열 배열이어야 한다' });
      }
      state.setLabels(next as string[]);
      activity.push('labels:changed', undefined, state.labels.join(', '));
    }
    return { labels: state.labels, overridden: state.overridden.labels };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 동시에 처리할 Task 수를 바꾼다.
 * 늘리면 즉시 반영되고, 줄이면 진행 중인 일이 끝난 뒤에 반영된다 —
 * 사람이 승인하기를 기다리는 작업을 중간에 끊을 수는 없기 때문이다.
 */
app.post('/ui/concurrency', async (req, reply) => {
  const { concurrency: next } = (req.body ?? {}) as { concurrency?: unknown };
  try {
    state.setConcurrency(Number(next));
    applyConcurrency();
    activity.push('concurrency:changed', undefined, String(state.concurrency));
    return { concurrency: state.concurrency, running: loops.length };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 사람이 직접 종료 처리한다 — 에이전트가 보고 없이 끝난 Task를 푸는 유일한 길이다.
 *
 * 이게 없으면 lease가 만료될 때까지(기본 10분) 그 Task가 Worker를 붙들고, 동시 처리
 * 수가 1이면 뒤가 전부 막힌다. 실제로 겪은 일이다.
 *
 * 에이전트의 보고와 같은 경로를 타되, 요약에 사람이 처리했음을 남긴다 —
 * 감사 기록이 "에이전트가 완료를 보고했다"고 거짓말하면 안 된다.
 */
app.post('/ui/tasks/:taskId/finish', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const { outcome, note } = (req.body ?? {}) as { outcome?: string; note?: string };
  if (outcome !== 'completed' && outcome !== 'failed') {
    return reply.code(400).send({ error: 'outcome must be completed or failed' });
  }
  const suffix = note?.trim() ? `: ${note.trim()}` : '';
  const result = worker.handleLocalReport(
    taskId,
    outcome === 'completed'
      ? { type: 'completed', summary: `사람이 직접 완료 처리함${suffix}` }
      : { type: 'failed', reason: `사람이 직접 종료함${suffix}` },
  );
  if (!result.ok) {
    // 에이전트가 시작되기 전(승인 대기)에는 보고를 받을 통로가 없다.
    // 그 단계에서 맞는 행동은 승인/거부이지 완료 처리가 아니다.
    const waiting = worker.approvals.some((a) => a.taskId === taskId);
    return reply.code(waiting ? 409 : 404).send({
      error: waiting
        ? '아직 시작 전이라 완료 처리할 수 없다 — 승인하거나 거부할 것'
        : `no task in progress: ${taskId}`,
    });
  }
  activity.push(`manual:${outcome}`, taskId, note?.trim() || undefined);
  return { ok: true };
});

/** worker-ui용 로컬 API */
app.get('/ui/state', async () => ({
  workerId,
  labels: state.labels,
  concurrency: state.concurrency,
  /** 실제로 도는 루프 수. 줄이는 중이면 concurrency보다 클 수 있다. */
  runningLoops: loops.length,
  configured: state.configured,
  overridden: state.overridden,
  controlPlaneUrl,
  defaultAgent: state.defaultAgent,
  current: worker.current,
  approvals: worker.approvals.map((a) => ({ ...a, agent: worker.chosenAgent(a.taskId) })),
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
  default: state.defaultAgent,
  configuredDefault: state.configured.defaultAgent,
}));

/**
 * 기본 에이전트를 바꾼다. Task별 드롭다운만 있으면 pending인 짧은 순간을 노려야 해서
 * 잘 안 먹는다 — "내 일은 다 이걸로 돌린다"는 여기서 정한다.
 */
app.post('/ui/default-agent', async (req, reply) => {
  const { agent } = (req.body ?? {}) as { agent?: string };
  try {
    state.setDefaultAgent(String(agent), Object.keys(adapters));
    activity.push('default-agent:changed', undefined, state.defaultAgent);
    return { default: state.defaultAgent, overridden: state.overridden.defaultAgent };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** UI 폴링 경로. 기본은 진행 중인 Task만 (종결분은 view=all로 명시해야 온다). */
app.get('/ui/tasks', async (req) => {
  const { view, limit } = req.query as { view?: 'active' | 'all'; limit?: string };
  return client.listTasks({ view, limit: limit ? Number(limit) : undefined });
});

/**
 * 처리할 에이전트 지정.
 *
 * 두 시점에 가능하다. 아직 아무도 안 집었으면(pending) 서버의 Task에 박고,
 * 이미 집혀서 승인을 기다리는 중이면 Worker가 들고 있다가 시작할 때 쓴다.
 * 어댑터는 승인 이후에 정해지므로 후자도 실제로 반영된다 —
 * pending인 짧은 순간을 노리지 않아도 되게 하려는 것이다.
 */
app.post('/ui/tasks/:taskId/agent', async (req, reply) => {
  const { taskId } = req.params as { taskId: string };
  const { agent } = (req.body ?? {}) as { agent?: string };
  if (!agent || !adapters[agent]) {
    return reply.code(400).send({ error: `unknown agent: ${agent}` });
  }
  if (worker.chooseAgent(taskId, agent)) {
    activity.push('agent:chosen', taskId, agent);
    return { ok: true, where: 'worker' };
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

/**
 * 독립적으로 도는 폴링 루프들. 개수가 곧 동시 처리 수다.
 * claim은 서버에서 원자적이라 같은 Task를 둘이 집는 일은 없고, 사람을 기다리는
 * Task가 있어도 다른 루프가 계속 다음 일을 집는다.
 */
const loops: { stop: boolean }[] = [];
const running: Promise<void>[] = [];

async function pollLoop(self: { stop: boolean }): Promise<void> {
  // 멈추라는 표시는 **다음 바퀴에서만** 본다 — 진행 중인 Task를 중간에 버리지 않는다.
  while (!stopping && !self.stop) {
    let processed = false;
    try {
      processed = await worker.processOne();
    } catch (err) {
      app.log.error({ err: String(err) }, 'poll iteration failed');
    }
    if (!processed) await sleep(pollIntervalMs);
  }
}

/** 현재 설정된 동시 처리 수에 맞게 루프를 늘리거나 줄인다. */
function applyConcurrency(): void {
  const target = state.concurrency;
  while (loops.length < target) {
    const self = { stop: false };
    loops.push(self);
    const task = pollLoop(self).finally(() => {
      const i = loops.indexOf(self);
      if (i >= 0) loops.splice(i, 1);
      const j = running.indexOf(task);
      if (j >= 0) running.splice(j, 1);
    });
    running.push(task);
  }
  // 줄일 때는 표시만 한다. 실제로 빠지는 건 그 루프가 지금 붙든 일을 끝낸 뒤다.
  for (let i = loops.length - 1; i >= target; i--) loops[i]!.stop = true;
}
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
      labels: state.labels,
      defaultAgent,
      listen: `${reportHost}:${reportPort}`,
      concurrency: state.concurrency,
      requireApproval: config.startGate.requireApproval,
    },
    'worker started, polling',
  );

  // 승인 대기가 길어져도 stalled로 빠지지 않게 살아 있다고 알린다.
  // lease의 1/3 주기 — 한두 번 놓쳐도 만료되지 않을 만큼 자주.
  const heartbeatMs = Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3));
  const heartbeat = setInterval(() => {
    const waiting = worker.approvals.map((a) => a.taskId);
    if (waiting.length === 0) return; // 연장할 게 없으면 부르지 않는다
    void client
      .heartbeat(workerId, waiting, leaseSeconds, state.labels)
      .catch((err) => app.log.error({ err: String(err) }, 'heartbeat failed'));
  }, heartbeatMs);
  heartbeat.unref();

  applyConcurrency();
  // 루프가 전부 끝날 때까지 기다린다. 도중에 수가 바뀌어도 running 배열이 갱신되므로
  // 여기서는 "지금 살아 있는 것들"을 반복해서 기다린다.
  while (running.length > 0) await Promise.race(running);
  clearInterval(heartbeat);
  await app.close();
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
