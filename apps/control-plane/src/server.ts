import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  claimRequestSchema,
  ingestRequestSchema,
  retryRequestSchema,
  setAgentRequestSchema,
  taskReportSchema,
  type TaskStatus,
} from '@samdi/protocol';
import { InvalidTransitionError } from '@samdi/task-domain';
import type { Db } from './db.js';
import { TaskNotFoundError, TaskNotPendingError, type TaskStore } from './task-store.js';

export interface ServerDeps {
  db: Db;
  store: TaskStore;
  /** MVP: Worker/관리 요청 공용 키. 개별 Worker 등록·키 발급은 이후 단계. */
  workerKey: string;
  logger?: boolean;
}

export function buildServer({ db, store, workerKey, logger = true }: ServerDeps) {
  const app = Fastify({ logger });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    if (err instanceof InvalidTransitionError || err instanceof TaskNotPendingError) {
      return reply.code(409).send({ error: err.message });
    }
    if (err instanceof TaskNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  const requireWorkerKey = (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (req.headers['x-worker-key'] !== workerKey) {
      reply.code(401).send({ error: 'invalid worker key' });
      return;
    }
    done();
  };

  app.get('/health', async () => ({ ok: true }));

  /** 외부 이벤트 수신. 채널별 키로 인증하며, 본문은 해석하지 않고 그대로 저장한다. */
  app.post('/channels/:channelId/events', async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const channel = db
      .prepare('SELECT id, label, key FROM channels WHERE id = ?')
      .get(channelId) as { id: string; label: string; key: string } | undefined;
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    if (req.headers['x-channel-key'] !== channel.key) {
      return reply.code(401).send({ error: 'invalid channel key' });
    }
    const body = ingestRequestSchema.parse(req.body);
    const task = await store.createTask(channel.id, channel.label, body.payload, body.agent);
    return { taskId: task.id };
  });

  app.post('/tasks/claim', { preHandler: requireWorkerKey }, async (req) => {
    const body = claimRequestSchema.parse(req.body);
    const task = store.claimNext(body.workerId, body.labels, body.leaseSeconds);
    const payload = task ? await store.getPayload(task.payloadRef) : null;
    return { task, payload };
  });

  app.post('/tasks/:taskId/report', { preHandler: requireWorkerKey }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    const report = taskReportSchema.parse(req.body);
    const task = store.applyReport(taskId, report);
    return { task };
  });

  /** 처리할 에이전트 지정 — pending 동안만 가능 */
  app.post('/tasks/:taskId/agent', { preHandler: requireWorkerKey }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    const body = setAgentRequestSchema.parse(req.body);
    const task = store.setAgent(taskId, body.agent);
    return { task };
  });

  /** stalled 수동 게이트 (MVP는 worker 키 공용, 사용자 인증 분리는 이후 단계) */
  app.post('/tasks/:taskId/retry', { preHandler: requireWorkerKey }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    const body = retryRequestSchema.parse(req.body);
    const task = store.resolveStalled(taskId, body.action);
    return { task };
  });

  app.get('/tasks', { preHandler: requireWorkerKey }, async (req) => {
    const { status } = req.query as { status?: TaskStatus };
    return { tasks: store.listTasks(status) };
  });

  app.get('/tasks/:taskId', { preHandler: requireWorkerKey }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    return store.getTaskDetail(taskId);
  });

  return app;
}
