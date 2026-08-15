import {
  claimResponseSchema,
  type Task,
  type TaskEvent,
  type TaskReport,
  type TaskStatus,
  type TaskSummary,
} from '@samdi/protocol';

export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly workerKey: string,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = {
      'x-worker-key': this.workerKey,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    // 본문이 있을 때만 content-type을 붙인다. 본문 없는 POST에 붙이면
    // Fastify가 "Body cannot be empty"로 거부한다.
    if (init?.body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async claim(
    workerId: string,
    labels: string[],
    leaseSeconds: number,
  ): Promise<{ task: Task | null; payload: string | null }> {
    const json = await this.request('/tasks/claim', {
      method: 'POST',
      body: JSON.stringify({ workerId, labels, leaseSeconds }),
    });
    return claimResponseSchema.parse(json);
  }

  async report(taskId: string, report: TaskReport): Promise<void> {
    await this.request(`/tasks/${taskId}/report`, {
      method: 'POST',
      body: JSON.stringify(report),
    });
  }

  async listTasks(
    opts: { status?: TaskStatus; view?: 'active' | 'all'; limit?: number } = {},
  ): Promise<{ tasks: TaskSummary[] }> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.view) params.set('view', opts.view);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.size > 0 ? `?${params}` : '';
    return (await this.request(`/tasks${qs}`)) as { tasks: TaskSummary[] };
  }

  async getTask(
    taskId: string,
  ): Promise<{ task: Task; payload: string | null; events: TaskEvent[] }> {
    return (await this.request(`/tasks/${taskId}`)) as {
      task: Task;
      payload: string | null;
      events: TaskEvent[];
    };
  }

  /** 시작 시 한 번: 이전 실행이 물고 있던 Task를 stalled로 되돌린다. */
  async recover(workerId: string): Promise<{ recovered: string[] }> {
    return (await this.request(`/workers/${workerId}/recover`, { method: 'POST' })) as {
      recovered: string[];
    };
  }

  async setAgent(taskId: string, agent: string): Promise<{ task: Task }> {
    return (await this.request(`/tasks/${taskId}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    })) as { task: Task };
  }

  async resolveStalled(taskId: string, action: 'retry' | 'abandon'): Promise<{ task: Task }> {
    return (await this.request(`/tasks/${taskId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    })) as { task: Task };
  }
}
