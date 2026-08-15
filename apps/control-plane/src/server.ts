import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  claimRequestSchema,
  createChannelRequestSchema,
  heartbeatRequestSchema,
  ingestRequestSchema,
  retryRequestSchema,
  setAgentRequestSchema,
  taskReportSchema,
  updateChannelRequestSchema,
  type TaskStatus,
} from '@samdi/protocol';
import { InvalidTransitionError } from '@samdi/task-domain';
import {
  ChannelExistsError,
  ChannelInUseError,
  ChannelNotEditableError,
  ChannelNotFoundError,
  type ChannelRegistry,
} from './channel-registry.js';
import type { Db } from './db.js';
import type { Pipeline } from './pipeline.js';
import type { WorkerRegistry } from './worker-registry.js';
import { TaskNotFoundError, TaskNotPendingError, type TaskStore } from './task-store.js';
import type { ThreadStore } from './thread-store.js';

export interface ServerDeps {
  db: Db;
  store: TaskStore;
  /** 수집기 → 해석기 → 분배기 */
  pipeline: Pipeline;
  threads: ThreadStore;
  /** 채널 목록·키의 주인 */
  channels: ChannelRegistry;
  /** claim에서 받아 적는 Worker 목록 */
  workers: WorkerRegistry;
  /** Worker가 claim·보고에 쓰는 키 */
  workerKey: string;
  /** 관리 화면이 쓰는 키. 전체 조회와 채널 등록·키 발급 권한. */
  adminKey: string;
  /** 빌드된 관리 UI 경로. 주면 서버가 `/`로 직접 서빙한다. */
  uiDist?: string;
  logger?: boolean;
}

export function buildServer({
  db,
  store,
  pipeline,
  threads,
  channels,
  workers,
  workerKey,
  adminKey,
  uiDist,
  logger = true,
}: ServerDeps) {
  const app = Fastify({ logger });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    if (err instanceof InvalidTransitionError || err instanceof TaskNotPendingError) {
      return reply.code(409).send({ error: err.message });
    }
    if (err instanceof TaskNotFoundError || err instanceof ChannelNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    if (err instanceof ChannelExistsError) {
      return reply.code(409).send({ error: err.message });
    }
    // 화면이 "Task N건이 함께 지워집니다"라고 물어볼 수 있게 개수를 함께 준다.
    if (err instanceof ChannelInUseError) {
      return reply.code(409).send({ error: err.message, refs: err.refs });
    }
    if (err instanceof ChannelNotEditableError) {
      return reply.code(403).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  /**
   * 인증은 세 갈래다. 키마다 할 수 있는 일이 다르다는 게 요점이다.
   *  - 채널 키  : 그 채널로 이벤트를 넣는 것만
   *  - Worker 키: 일을 가져가고(claim) 결과를 보고하는 것
   *  - 관리 키  : 전체 조회와 채널 등록·키 발급
   * Worker가 뚫려도 채널을 만들거나 전체를 훑을 수 없어야 하므로 뒤 둘을 나눈다.
   */
  const requireWorkerKey = (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (req.headers['x-worker-key'] !== workerKey) {
      reply.code(401).send({ error: 'invalid worker key' });
      return;
    }
    done();
  };

  const requireAdminKey = (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (req.headers['x-admin-key'] !== adminKey) {
      reply.code(401).send({ error: 'invalid admin key' });
      return;
    }
    done();
  };

  /**
   * Worker와 관리 화면이 함께 보는 경로. Worker는 자기가 집을 Task를 봐야 하고,
   * 관리 화면은 전체를 봐야 한다 — 둘 다 정당하므로 어느 키든 받는다.
   */
  const requireWorkerOrAdmin = (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (req.headers['x-worker-key'] === workerKey || req.headers['x-admin-key'] === adminKey) {
      done();
      return;
    }
    reply.code(401).send({ error: 'invalid key' });
  };

  app.get('/health', async () => ({ ok: true }));

  /** 외부 이벤트 수신. 채널별 키로 인증하며, 본문은 해석하지 않고 그대로 저장한다. */
  app.post('/channels/:channelId/events', async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const channel = channels.authenticate(channelId, req.headers['x-channel-key'] as string);
    if (!channel) {
      // 없는 채널인지 키가 틀린 건지 구분해서 알려주지 않는다 — 채널 id를 훑는 데 쓰인다.
      return reply.code(401).send({ error: 'unknown channel or invalid channel key' });
    }
    const body = ingestRequestSchema.parse(req.body);
    return pipeline.ingest(channel.config.id, body.payload, {
      agent: body.agent,
      contextKey: body.contextKey,
    });
  });

  /** 문맥 스레드 관찰용 (llm 모드 채널) */
  app.get('/channels/:channelId/threads', { preHandler: requireWorkerOrAdmin }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    return { threads: threads.listByChannel(channelId) };
  });

  app.get('/threads/:threadId', { preHandler: requireWorkerOrAdmin }, async (req, reply) => {
    const { threadId } = req.params as { threadId: string };
    const thread = threads.get(threadId);
    if (!thread) return reply.code(404).send({ error: `thread not found: ${threadId}` });
    return { thread, events: threads.events(threadId) };
  });

  app.post('/tasks/claim', { preHandler: requireWorkerKey }, async (req) => {
    const body = claimRequestSchema.parse(req.body);
    // 일을 가져가든 못 가져가든 "이 Worker가 이 라벨을 보고 있다"는 사실을 남긴다.
    // 관리 화면이 아무도 안 보는 라벨을 짚어낼 수 있는 근거가 이것뿐이다.
    workers.seen(body.workerId, body.labels);
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

  /**
   * Worker 재시작 신고. 그 Worker가 물고 있던 진행 중 Task를 stalled로 세운다.
   * (에이전트도 승인 대기도 함께 사라졌으므로, 사람이 재시도를 결정해야 한다.)
   */
  app.post('/workers/:workerId/recover', { preHandler: requireWorkerKey }, async (req) => {
    const { workerId } = req.params as { workerId: string };
    return { recovered: store.recoverWorkerTasks(workerId) };
  });

  /**
   * Worker가 살아 있다는 신호. 승인 대기 중인 Task의 lease를 연장한다.
   *
   * 사람이 승인 버튼을 늦게 누른다고 Task가 stalled로 빠지면 안 된다. 반대로
   * 진행 중인 Task까지 연장하면 에이전트가 조용히 죽은 걸 못 잡으므로 연장하지 않는다.
   */
  app.post('/workers/:workerId/heartbeat', { preHandler: requireWorkerKey }, async (req) => {
    const { workerId } = req.params as { workerId: string };
    const body = heartbeatRequestSchema.parse(req.body);
    workers.seen(workerId, body.labels);
    return { extended: store.extendWaitingLeases(workerId, body.taskIds, body.leaseSeconds) };
  });

  /** 처리할 에이전트 지정 — pending 동안만 가능 */
  app.post('/tasks/:taskId/agent', { preHandler: requireWorkerOrAdmin }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    const body = setAgentRequestSchema.parse(req.body);
    const task = store.setAgent(taskId, body.agent);
    return { task };
  });

  /** stalled 수동 게이트 (MVP는 worker 키 공용, 사용자 인증 분리는 이후 단계) */
  app.post('/tasks/:taskId/retry', { preHandler: requireWorkerOrAdmin }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    const body = retryRequestSchema.parse(req.body);
    const task = store.resolveStalled(taskId, body.action);
    return { task };
  });

  /**
   * Task 목록. 기본은 진행 중인 것만 최신순으로 (UI가 초 단위로 폴링하는 경로).
   * 종결분까지 보려면 view=all, 특정 상태만 보려면 status=<상태>.
   */
  app.get('/tasks', { preHandler: requireWorkerOrAdmin }, async (req) => {
    const { status, view, limit, offset } = req.query as {
      status?: TaskStatus;
      view?: 'active' | 'all';
      limit?: string;
      offset?: string;
    };
    // { tasks, total } — total은 화면이 페이지 수를 계산하는 데 쓴다.
    return store.listTasks({
      status,
      view,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  app.get('/tasks/:taskId', { preHandler: requireWorkerOrAdmin }, async (req) => {
    const { taskId } = req.params as { taskId: string };
    return store.getTaskDetail(taskId);
  });

  // ── 관리 화면 (Control Plane UI) ─────────────────────────────────────────
  // 여기 있는 것들은 서버가 소유한 전체 상태를 다룬다. Worker 키로는 닿지 않는다.

  const admin = { preHandler: requireAdminKey };

  /** 한 화면에 필요한 집계. 상태별 개수는 SQL로 세고 목록은 따로 부른다. */
  app.get('/admin/overview', admin, async () => {
    const taskCounts = db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
      .all() as { status: string; n: number }[];
    const threadCounts = db
      .prepare('SELECT status, COUNT(*) AS n FROM context_threads GROUP BY status')
      .all() as { status: string; n: number }[];
    // 지금 일을 물고 있는 건 Task에서 세고, "누가 무슨 라벨을 보는가"는 claim 기록에서 온다.
    // 둘을 합쳐야 쉬고 있는 Worker도 보인다 — 그게 라벨 미스매치를 짚는 근거다.
    const inFlight = new Map(
      (
        db
          .prepare(
            `SELECT worker_id AS workerId, COUNT(*) AS n, MAX(lease_expires_at) AS leaseExpiresAt
             FROM tasks
             WHERE worker_id IS NOT NULL AND status IN ('claimed','running','waiting')
             GROUP BY worker_id`,
          )
          .all() as { workerId: string; n: number; leaseExpiresAt: string | null }[]
      ).map((r) => [r.workerId, r]),
    );

    const workerList = workers.list().map((w) => ({
      ...w,
      inFlight: inFlight.get(w.workerId)?.n ?? 0,
      leaseExpiresAt: inFlight.get(w.workerId)?.leaseExpiresAt ?? null,
    }));

    const tally = (rows: { status: string; n: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.status, r.n]));

    return {
      tasks: tally(taskCounts),
      threads: tally(threadCounts),
      workers: workerList,
      /**
       * 최근 살아 있던 Worker들이 보는 라벨. 여기 없는 라벨로 만든 Task는
       * 아무도 가져가지 않으므로 화면이 경고할 수 있다.
       */
      coveredLabels: workers.coveredLabels(),
      channels: channels.list().length,
    };
  });

  /** 채널 목록. 키는 가려서 나간다 — 평문은 발급 응답에서만 볼 수 있다. */
  app.get('/admin/channels', admin, async () => ({
    channels: channels.list().map((c) => ({ ...c, maskedKey: channels.maskedKey(c.id) })),
  }));

  /**
   * 채널 등록 + 키 발급.
   * **응답의 key는 여기서만 볼 수 있다.** 이후 조회에서는 가려진 형태만 나간다.
   */
  app.post('/admin/channels', admin, async (req, reply) => {
    const body = createChannelRequestSchema.parse(req.body);
    const created = channels.create(body);
    return reply.code(201).send(created);
  });

  /**
   * 라벨·해석기 수정. 키는 그대로다.
   * 등록할 때 아무도 안 보는 라벨을 골랐다는 걸 나중에 알게 되므로 필요하다 —
   * 지웠다 다시 만들면 키가 바뀌어 웹훅 설정을 전부 고쳐야 한다.
   */
  app.patch('/admin/channels/:channelId', admin, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const body = updateChannelRequestSchema.parse(req.body);
    return { channel: channels.update(channelId, body) };
  });

  /** 키 재발급. 예전 키는 즉시 통하지 않는다. */
  app.post('/admin/channels/:channelId/key', admin, async (req) => {
    const { channelId } = req.params as { channelId: string };
    return { key: channels.rotateKey(channelId) };
  });

  /**
   * 비활성화 — 이벤트 수신만 멈춘다. 채널도 그 채널이 만든 기록도 남는다.
   * "이 채널은 이제 안 쓴다"에는 이쪽이 맞다.
   */
  app.post('/admin/channels/:channelId/disable', admin, async (req) => {
    const { channelId } = req.params as { channelId: string };
    channels.disable(channelId);
    return { ok: true };
  });

  /**
   * 삭제 — 목록에서 없앤다.
   *
   * 참조하는 기록이 없으면 그냥 지운다. 있으면 409로 거부하면서 무엇이 걸려 있는지
   * 알려준다 — 그때는 비활성화하거나 `?purge=true`로 기록째 지운다.
   * **purge는 되돌릴 수 없다.**
   */
  app.delete('/admin/channels/:channelId', admin, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const { purge } = req.query as { purge?: string };
    const removed = channels.remove(channelId, { purge: purge === 'true' });
    return { ok: true, removed };
  });

  /**
   * 관리 화면에서 이벤트를 넣어본다 — 채널이 제대로 도는지 확인하는 도구다.
   * 채널 키 없이 되는 이유는 관리 키가 이미 더 센 권한이기 때문이다.
   */
  app.post('/admin/channels/:channelId/events', admin, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!channels.get(channelId)) {
      return reply.code(404).send({ error: `unknown channel: ${channelId}` });
    }
    const body = ingestRequestSchema.parse(req.body);
    return pipeline.ingest(channelId, body.payload, {
      agent: body.agent,
      contextKey: body.contextKey,
    });
  });

  // 빌드된 관리 화면을 같은 출처로 내보낸다 (설정된 경우에만).
  // 위에 등록한 명시 라우트가 정적 와일드카드보다 우선한다.
  // 화면 자체는 인증 없이 받는다 — 키를 요구하는 건 그 안에서 부르는 API다.
  if (uiDist) {
    if (!existsSync(uiDist)) {
      app.log.error({ uiDist }, 'uiDist 경로가 없다 — 관리 화면을 서빙하지 않는다');
    } else {
      void app.register(fastifyStatic, { root: uiDist });
      app.log.info({ uiDist }, 'serving control-plane-ui');
    }
  }

  return app;
}
