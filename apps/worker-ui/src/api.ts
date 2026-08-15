import type { Task, TaskEvent, TaskSummary } from '@samdi/protocol';

export interface ActivityEntry {
  at: string;
  type: string;
  taskId?: string;
  detail?: string;
}

export interface CurrentTask {
  taskId: string;
  label: string;
  phase: string;
  startedAt: string;
}

export interface PendingApproval {
  taskId: string;
  question: string;
  askedAt: string;
}

export interface UiState {
  workerId: string;
  /** 지금 claim에 쓰는 라벨 */
  labels: string[];
  /** 설정 파일에 적힌 값. "되돌리기"의 목적지다. */
  configuredLabels: string[];
  /** 설정값과 다른 값을 쓰고 있는가 */
  labelsOverridden: boolean;
  controlPlaneUrl: string;
  /** 동시에 처리 중인 Task들 */
  current: CurrentTask[];
  /** 사용자 결정을 기다리는 승인들 */
  approvals: PendingApproval[];
  concurrency: number;
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
  /** 기본은 진행 중인 Task만. 종결분까지 보려면 view: 'all' (전체 조회 화면은 이후 단계). */
  tasks: (view?: 'active' | 'all') =>
    get<{ tasks: TaskSummary[] }>(`/ui/tasks${view ? `?view=${view}` : ''}`),
  setAgent: (id: string, agent: string) =>
    post<{ task: Task }>(`/ui/tasks/${id}/agent`, { agent }),
  task: (id: string) => get<TaskDetail>(`/ui/tasks/${id}`),
  resolve: (id: string, action: 'retry' | 'abandon') =>
    post<{ task: Task }>(`/ui/tasks/${id}/resolve`, { action }),
  approve: (id: string, decision: 'approve' | 'deny') =>
    post<{ ok: boolean }>(`/ui/tasks/${id}/approve`, { decision }),
  /** 받을 라벨을 바꾼다. 다음 claim부터 적용된다 — 재시작이 필요 없다. */
  setLabels: (labels: string[]) =>
    post<{ labels: string[]; overridden: boolean }>('/ui/labels', { labels }),
  resetLabels: () => post<{ labels: string[]; overridden: boolean }>('/ui/labels', { reset: true }),
};
