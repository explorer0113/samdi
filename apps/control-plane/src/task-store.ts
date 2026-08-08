import { randomUUID } from 'node:crypto';
import type { Task, TaskEvent, TaskReport, TaskStatus, TaskSummary } from '@samdi/protocol';
import { assertTransition, type PayloadStore } from '@samdi/task-domain';
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
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Worker 보고 타입 → 목표 상태. 전이의 합법성은 상태 머신이 검증한다. */
const REPORT_TARGET: Record<TaskReport['type'], TaskStatus> = {
  triaged_out: 'triaged_out',
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
  ): Promise<Task> {
    const ref = await this.payloads.put(payload);
    const t = now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, channel_id, label, payload_ref, status, agent, worker_id, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
      )
      .run(id, channelId, label, ref, agent ?? null, t, t);
    this.appendEvent(id, 'created', { channelId, label, ...(agent ? { agent } : {}) });
    return toTask(this.getRow(id));
  }

  /** 원자적 claim. pending 중 라벨이 맞는 가장 오래된 Task 하나를 가져간다. */
  claimNext(workerId: string, labels: string[], leaseSeconds: number): Task | null {
    this.sweepExpiredLeases();
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

  listTasks(status?: TaskStatus): TaskSummary[] {
    const select = `SELECT t.*, substr(p.body, 1, 120) AS preview
       FROM tasks t JOIN payloads p ON p.ref = t.payload_ref`;
    const rows = (
      status
        ? this.db.prepare(`${select} WHERE t.status = ? ORDER BY t.created_at`).all(status)
        : this.db.prepare(`${select} ORDER BY t.created_at`).all()
    ) as Array<TaskRow & { preview: string }>;
    return rows.map((row) => ({ ...toTask(row), preview: row.preview }));
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
