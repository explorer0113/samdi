import type { Task, TaskEvent, TaskSummary } from '@samdi/protocol';

export interface ActivityEntry {
  at: string;
  type: string;
  taskId?: string;
  detail?: string;
}

export interface UiState {
  workerId: string;
  labels: string[];
  controlPlaneUrl: string;
  current: { taskId: string; label: string; phase: string; startedAt: string } | null;
  approval: { taskId: string; question: string; askedAt: string } | null;
  activity: ActivityEntry[];
}

export interface TaskDetail {
  task: Task;
  payload: string | null;
  events: TaskEvent[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface AgentsInfo {
  agents: string[];
  default: string;
}

export const api = {
  state: () => get<UiState>('/ui/state'),
  agents: () => get<AgentsInfo>('/ui/agents'),
  tasks: () => get<{ tasks: TaskSummary[] }>('/ui/tasks'),
  setAgent: (id: string, agent: string) =>
    post<{ task: Task }>(`/ui/tasks/${id}/agent`, { agent }),
  task: (id: string) => get<TaskDetail>(`/ui/tasks/${id}`),
  resolve: (id: string, action: 'retry' | 'abandon') =>
    post<{ task: Task }>(`/ui/tasks/${id}/resolve`, { action }),
  approve: (id: string, decision: 'approve' | 'deny') =>
    post<{ ok: boolean }>(`/ui/tasks/${id}/approve`, { decision }),
  inject: (payload: string, agent?: string) =>
    post<{ taskId: string }>('/ui/demo/inject', { payload, ...(agent ? { agent } : {}) }),
};
