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

  private headers() {
    return { 'content-type': 'application/json', 'x-worker-key': this.workerKey };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
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

  async listTasks(status?: TaskStatus): Promise<{ tasks: TaskSummary[] }> {
    const qs = status ? `?status=${status}` : '';
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
