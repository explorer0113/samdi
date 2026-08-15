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
  /** 승인 화면에서 사용자가 고른 에이전트 (안 골랐으면 undefined) */
  agent?: string;
}

export interface UiState {
  workerId: string;
  /** 지금 claim에 쓰는 라벨 */
  labels: string[];
  /** 동시에 처리하기로 한 수 */
  concurrency: number;
  /** 실제로 도는 루프 수. 줄이는 중이면 concurrency보다 클 수 있다. */
  runningLoops: number;
  /** 설정 파일에 적힌 값. "되돌리기"의 목적지다. */
  /** Task에 지정이 없을 때 쓸 에이전트 */
  defaultAgent: string;
  configured: { labels: string[]; concurrency: number; defaultAgent: string };
  /** 설정값과 다른 값을 쓰고 있는가 */
  overridden: { labels: boolean; concurrency: boolean; defaultAgent: boolean };
  controlPlaneUrl: string;
  /** 동시에 처리 중인 Task들 */
  current: CurrentTask[];
  /** 사용자 결정을 기다리는 승인들 */
  approvals: PendingApproval[];
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
  configuredDefault: string;
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
  /** 동시에 처리할 수. 늘리면 즉시, 줄이면 진행 중인 일이 끝난 뒤 반영된다. */
  setConcurrency: (concurrency: number) =>
    post<{ concurrency: number; running: number }>('/ui/concurrency', { concurrency }),
  /** 기본 에이전트. Task별로 고르는 것과 달리 시점을 놓칠 일이 없다. */
  setDefaultAgent: (agent: string) =>
    post<{ default: string; overridden: boolean }>('/ui/default-agent', { agent }),
  /**
   * 사람이 직접 종료 처리한다 — 에이전트가 보고 없이 끝난 Task를 푸는 길.
   * 두면 lease가 만료될 때까지 Worker를 붙들고 있어 뒤가 막힌다.
   */
  finish: (id: string, outcome: 'completed' | 'failed', note?: string) =>
    post<{ ok: boolean }>(`/ui/tasks/${id}/finish`, { outcome, ...(note ? { note } : {}) }),
};
