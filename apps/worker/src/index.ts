import Fastify from 'fastify';
import { ConfigError, loadWorkerConfig } from '@samdi/config';
import { localReportSchema } from '@samdi/protocol';
import {
  ClaudeCodeAdapter,
  ClaudeCodeTerminalAdapter,
  MockAgentAdapter,
  type AgentAdapter,
} from '@samdi/agent-adapter';
import { AllowAllStartGate } from '@samdi/policy-gateway';
import { ActivityLog } from './activity-log.js';
import { ControlPlaneClient } from './control-plane-client.js';
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
const channelKey = config.controlPlane.channelKey;
const { id: workerId, labels, pollIntervalMs, leaseSeconds, reportPort } = config.worker;
const defaultAgent = config.defaultAgent;

const app = Fastify({ logger: true });
const activity = new ActivityLog();
const client = new ControlPlaneClient(controlPlaneUrl, config.controlPlane.workerKey);

/** UI 드롭다운에서 Task별로 고를 수 있는 어댑터 레지스트리 */
const adapters: Record<string, AgentAdapter> = {
  mock: new MockAgentAdapter(),
  'claude-code': new ClaudeCodeAdapter(config.agents['claude-code']),
  // 백그라운드가 아니라 Terminal 창을 띄워 사용자가 과정을 직접 본다 (macOS)
  'claude-code-terminal': new ClaudeCodeTerminalAdapter(config.agents['claude-code-terminal']),
};

const worker = new Worker({
  client,
  gate: new AllowAllStartGate(),
  adapters,
  defaultAgent,
  activity,
  workerId,
  labels,
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

/** worker-ui용 로컬 API */
app.get('/ui/state', async () => ({
  workerId,
  labels,
  controlPlaneUrl,
  current: worker.current,
  approval: worker.approval,
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

app.get('/ui/tasks', async () => client.listTasks());

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

/** 데모 편의: 외부 웹훅 흉내. 실제 배포에선 이벤트가 채널로 직접 들어온다. */
app.post('/ui/demo/inject', async (req, reply) => {
  const { payload, agent } = (req.body ?? {}) as { payload?: string; agent?: string };
  if (!payload) return reply.code(400).send({ error: 'payload required' });
  if (agent && !adapters[agent]) {
    return reply.code(400).send({ error: `unknown agent: ${agent}` });
  }
  const res = await fetch(`${controlPlaneUrl}/channels/demo/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-channel-key': channelKey },
    body: JSON.stringify({ payload, ...(agent ? { agent } : {}) }),
  });
  if (!res.ok) return reply.code(502).send({ error: await res.text() });
  return res.json();
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
  await app.listen({ port: reportPort, host: '127.0.0.1' });
  app.log.info(
    {
      config: source ?? '(기본값)',
      controlPlaneUrl,
      workerId,
      labels,
      defaultAgent,
      reportPort,
    },
    'worker started, polling',
  );
  while (!stopping) {
    let processed = false;
    try {
      processed = await worker.processOne();
    } catch (err) {
      app.log.error({ err: String(err) }, 'poll iteration failed');
    }
    if (!processed) await sleep(pollIntervalMs);
  }
  await app.close();
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
