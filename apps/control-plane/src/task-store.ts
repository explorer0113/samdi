import { randomUUID } from 'node:crypto';
import type { Task, TaskEvent, TaskReport, TaskStatus, TaskSummary } from '@samdi/protocol';
import { TERMINAL_STATUSES, assertTransition, type PayloadStore } from '@samdi/task-domain';
import type { Db } from './db.js';

const now = () => new Date().toISOString();

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskNotPendingError extends Error {
  constructor(taskId: string, status: string) {
    super(`task not pending: ${taskId} (${status})`);
    this.name = 'TaskNotPendingError';
  }
}

export class SqlitePayloadStore implements PayloadStore {
  constructor(private readonly db: Db) {}

  async put(payload: string): Promise<string> {
    const ref = randomUUID();
    this.db
      .prepare('INSERT INTO payloads (ref, body, created_at) VALUES (?, ?, ?)')
      .run(ref, payload, now());
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    const row = this.db.prepare('SELECT body FROM payloads WHERE ref = ?').get(ref) as
      | { body: string }
      | undefined;
    return row?.body ?? null;
  }
}

interface TaskRow {
  id: string;
  channel_id: string;
  label: string;
  payload_ref: string;
  status: string;
  agent: string | null;
  thread_id: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    channelId: row.channel_id,
    label: row.label,
    payloadRef: row.payload_ref,
    status: row.status as TaskStatus,
    agent: row.agent,
    threadId: row.thread_id,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Worker 보고 타입 → 목표 상태. 전이의 합법성은 상태 머신이 검증한다. */
const REPORT_TARGET: Record<TaskReport['type'], TaskStatus> = {
  rejected: 'rejected',
  started: 'running',
  waiting: 'waiting',
  resumed: 'running',
  completed: 'completed',
  failed: 'failed',
};

export class TaskStore {
  constructor(
    private readonly db: Db,
    private readonly payloads: PayloadStore,
  ) {}

  private appendEvent(taskId: string, type: string, data: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO task_events (id, task_id, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, now(), type, JSON.stringify(data));
  }

  private getRow(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  async createTask(
    channelId: string,
    label: string,
    payload: string,
    agent?: string,
    threadId?: string,
  ): Promise<Task> {
    const ref = await this.payloads.put(payload);
    const t = now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, channel_id, label, payload_ref, status, agent, thread_id, worker_id, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, channelId, label, ref, agent ?? null, threadId ?? null, t, t);
    this.appendEvent(id, 'created', {
      channelId,
      label,
      ...(agent ? { agent } : {}),
      ...(threadId ? { threadId } : {}),
    });
    return toTask(this.getRow(id));
  }

  /**
   * 원자적 claim. pending 중 라벨이 맞는 가장 오래된 Task 하나를 가져간다.
   *
   * 여기서 lease 만료 스캔을 돌리지 않는다 — 만료는 stalled로 가지 pending으로
   * 돌아오지 않으므로 claim할 거리가 늘지 않는다. Worker마다 매 폴링에서 전체를
   * 훑던 순수 낭비였다. 만료 처리는 주기 스캔이 맡는다.
   */
  claimNext(workerId: string, labels: string[], leaseSeconds: number): Task | null {
    const placeholders = labels.map(() => '?').join(', ');
    const tx = this.db.transaction((): TaskRow | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM tasks WHERE status = 'pending' AND label IN (${placeholders})
           ORDER BY created_at LIMIT 1`,
        )
        .get(...labels) as TaskRow | undefined;
      if (!row) return null;
      assertTransition(row.status as TaskStatus, 'claimed');
      const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      this.db
        .prepare(
          `UPDATE tasks SET status = 'claimed', worker_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(workerId, lease, now(), row.id);
      this.appendEvent(row.id, 'claimed', { workerId, leaseExpiresAt: lease });
      return this.getRow(row.id);
    });
    const claimed = tx();
    return claimed ? toTask(claimed) : null;
  }

  applyReport(taskId: string, report: TaskReport): Task {
    const row = this.getRow(taskId);
    const target = REPORT_TARGET[report.type];
    assertTransition(row.status as TaskStatus, target);
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(target, now(), taskId);
    this.appendEvent(taskId, `report:${report.type}`, report);
    return toTask(this.getRow(taskId));
  }

  /** 처리할 에이전트 지정. claim되기 전(pending)에만 의미가 있으므로 그때만 허용한다. */
  setAgent(taskId: string, agent: string): Task {
    const row = this.getRow(taskId);
    if (row.status !== 'pending') {
      throw new TaskNotPendingError(taskId, row.status);
    }
    this.db
      .prepare('UPDATE tasks SET agent = ?, updated_at = ? WHERE id = ?')
      .run(agent, now(), taskId);
    this.appendEvent(taskId, 'agent_assigned', { agent });
    return toTask(this.getRow(taskId));
  }

  /** stalled Task의 수동 게이트: 사용자만 재시도(pending) 또는 포기(failed)로 옮길 수 있다. */
  resolveStalled(taskId: string, action: 'retry' | 'abandon'): Task {
    const row = this.getRow(taskId);
    const target: TaskStatus = action === 'retry' ? 'pending' : 'failed';
    assertTransition(row.status as TaskStatus, target);
    this.db
      .prepare(
        'UPDATE tasks SET status = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(target, now(), taskId);
    this.appendEvent(taskId, action === 'retry' ? 'retried' : 'abandoned', {});
    return toTask(this.getRow(taskId));
  }

  /**
   * Worker가 다시 시작했을 때, 그 Worker가 물고 있던 진행 중 Task를 stalled로 되돌린다.
   *
   * 재시작하면 에이전트 프로세스도, 승인 대기 같은 메모리 상태도 함께 사라진다.
   * 그대로 두면 Task가 waiting/running에 멈춘 채 lease 만료까지(기본 10분) 방치되고,
   * 승인 버튼도 뜨지 않는다. 부수효과가 이미 나갔는지는 알 수 없으므로 자동 재실행이
   * 아니라 stalled로 세워 사람이 재시도/포기를 고르게 한다.
   */
  recoverWorkerTasks(workerId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id, status FROM tasks
         WHERE worker_id = ? AND status IN ('claimed', 'running', 'waiting')`,
      )
      .all(workerId) as Array<{ id: string; status: string }>;
    for (const row of rows) {
      this.db
        .prepare(`UPDATE tasks SET status = 'stalled', updated_at = ? WHERE id = ?`)
        .run(now(), row.id);
      this.appendEvent(row.id, 'stalled', { from: row.status, reason: 'worker 재시작' });
    }
    return rows.map((r) => r.id);
  }

  /**
   * 승인 대기 중인 Task의 lease를 연장한다 — 사람을 기다리는 동안은 시계를 멈춘다.
   *
   * **`waiting`만 연장하는 게 요점이다.** 진행 중(`claimed`·`running`)까지 연장하면
   * 에이전트가 조용히 죽은 경우(터미널 창을 그냥 닫는 등)를 영영 못 잡는다. 그건
   * lease가 잡아야 할 바로 그 상황이다. 반면 `waiting`은 왜 안 끝나는지 시스템이
   * 이미 알고 있고 — 사람이 아직 안 눌렀다 — 그걸 실패로 볼 이유가 없다.
   *
   * Worker가 죽으면 heartbeat도 멈추므로 waiting도 결국 만료된다. 즉 이 연장은
   * "Worker가 살아 있고 아직 이 Task를 붙들고 있다"는 사실에만 기댄다.
   */
  extendWaitingLeases(workerId: string, taskIds: string[], leaseSeconds: number): string[] {
    if (taskIds.length === 0) return [];
    const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id FROM tasks
         WHERE worker_id = ? AND status = 'waiting' AND id IN (${placeholders})`,
      )
      .all(workerId, ...taskIds) as Array<{ id: string }>;
    if (rows.length === 0) return [];

    const update = this.db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?');
    for (const row of rows) update.run(until, row.id);
    // 감사 이벤트는 남기지 않는다 — 주기적으로 도는 신호라 타임라인을 덮어버린다.
    return rows.map((r) => r.id);
  }

  /** lease 만료 → stalled. 자동 재배포는 하지 않는다 (SOP: 수동 게이트). */
  sweepExpiredLeases(): number {
    const t = now();
    const rows = this.db
      .prepare(
        `SELECT id, status FROM tasks
         WHERE status IN ('claimed', 'running', 'waiting') AND lease_expires_at < ?`,
      )
      .all(t) as Array<{ id: string; status: string }>;
    for (const row of rows) {
      this.db
        .prepare(`UPDATE tasks SET status = 'stalled', updated_at = ? WHERE id = ?`)
        .run(now(), row.id);
      this.appendEvent(row.id, 'stalled', { from: row.status });
    }
    return rows.length;
  }

  /**
   * Task 목록. 최신순(created_at DESC)으로, 기본은 진행 중인 것만 준다.
   *
   * UI가 초 단위로 폴링하는 경로이므로 종결된 Task까지 매번 실어 보내지 않는다.
   * 종결분을 보려면 view: 'all' 또는 status를 명시한다 (관리자 화면은 이후 단계).
   */
  /**
   * Task 목록. 기본은 진행 중인 것만 최신순으로 (UI가 초 단위로 폴링하는 경로).
   *
   * 관리 화면은 종결분까지 봐야 해서 금방 수백 건이 되므로 페이지로 끊는다.
   * `total`을 함께 주는 이유는 "몇 페이지가 더 있는가"를 화면이 알아야 하기 때문이다.
   */
  listTasks(
    opts: { status?: TaskStatus; view?: 'active' | 'all'; limit?: number; offset?: number } = {},
  ): { tasks: TaskSummary[]; total: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const select = `SELECT t.*, substr(p.body, 1, 120) AS preview
       FROM tasks t JOIN payloads p ON p.ref = t.payload_ref`;
    const tail = 'ORDER BY t.created_at DESC LIMIT ? OFFSET ?';

    let where = '';
    let params: unknown[] = [];
    if (opts.status) {
      where = 'WHERE t.status = ?';
      params = [opts.status];
    } else if (opts.view !== 'all') {
      where = `WHERE t.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})`;
      params = [...TERMINAL_STATUSES];
    }

    const rows = this.db
      .prepare(`${select} ${where} ${tail}`)
      .all(...params, limit, offset) as Array<TaskRow & { preview: string }>;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks t ${where}`)
      .get(...params) as { total: number };

    return { tasks: rows.map((row) => ({ ...toTask(row), preview: row.preview })), total };
  }

  async getTaskDetail(
    taskId: string,
  ): Promise<{ task: Task; payload: string | null; events: TaskEvent[] }> {
    const task = toTask(this.getRow(taskId));
    const payload = await this.payloads.get(task.payloadRef);
    const events = (
      this.db
        .prepare('SELECT id, task_id, at, type, data FROM task_events WHERE task_id = ? ORDER BY at')
        .all(taskId) as Array<{ id: string; task_id: string; at: string; type: string; data: string }>
    ).map((e) => ({
      id: e.id,
      taskId: e.task_id,
      at: e.at,
      type: e.type,
      data: JSON.parse(e.data) as Record<string, unknown>,
    }));
    return { task, payload, events };
  }

  getPayload(ref: string): Promise<string | null> {
    return this.payloads.get(ref);
  }
}
