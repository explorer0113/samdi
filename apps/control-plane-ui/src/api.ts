import type { Task, TaskEvent, TaskSummary } from '@samdi/protocol';

/**
 * 관리 화면은 Control Plane API를 **직접** 부른다.
 *
 * Worker UI는 Worker를 거쳐 가고 키를 브라우저에 두지 않는다 — 그쪽은 사용자 기기 안에서
 * 도는 화면이기 때문이다. 반면 관리 화면은 서버를 상대하므로 관리 키를 스스로 들고 있어야 한다.
 * 지금은 브라우저 저장소에 넣어둔다. 세션·SSO는 이후 단계다.
 */
const KEY_STORAGE = 'samdi.adminKey';

export function loadKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function saveKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

/** 키가 틀렸을 때는 화면이 입력을 다시 받아야 하므로 따로 구분한다. */
export class UnauthorizedError extends Error {
  constructor() {
    super('관리 키가 올바르지 않습니다');
    this.name = 'UnauthorizedError';
  }
}

/**
 * 지우려는 채널을 Task·스레드가 참조 중이다.
 * 몇 건인지 들고 있어서, 화면이 "이만큼 함께 지워집니다"라고 물어볼 수 있다.
 */
export class ChannelInUseError extends Error {
  constructor(
    message: string,
    readonly refs: { tasks: number; threads: number },
  ) {
    super(message);
    this.name = 'ChannelInUseError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = loadKey();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(key ? { 'x-admin-key': key } : {}),
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 409) {
      const parsed = safeJson(body) as { error?: string; refs?: { tasks: number; threads: number } };
      if (parsed?.refs) throw new ChannelInUseError(parsed.error ?? body, parsed.refs);
    }
    throw new Error(`${path}: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export interface InterpreterInfo {
  mode: 'passthrough' | 'claude' | 'http';
  ttlSeconds: number;
  debounceMs: number;
  labels: string[];
}

export interface ChannelRow {
  id: string;
  label: string;
  source: 'config' | 'api';
  createdAt: string;
  disabledAt: string | null;
  maskedKey: string | null;
  interpreter: InterpreterInfo;
}

export interface WorkerRow {
  workerId: string;
  /** 이 Worker가 claim하겠다고 밝힌 라벨 */
  labels: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  inFlight: number;
  leaseExpiresAt: string | null;
}

export interface Overview {
  /** 상태별 Task 수 */
  tasks: Record<string, number>;
  /** 상태별 문맥 스레드 수 */
  threads: Record<string, number>;
  workers: WorkerRow[];
  /** 최근 살아 있던 Worker들이 보는 라벨. 여기 없는 라벨은 아무도 가져가지 않는다. */
  coveredLabels: string[];
  channels: number;
}

export interface TaskDetail {
  task: Task;
  payload: string | null;
  events: TaskEvent[];
}

export const api = {
  overview: () => get<Overview>('/admin/overview'),
  channels: () => get<{ channels: ChannelRow[] }>('/admin/channels'),
  createChannel: (body: { id: string; label?: string; interpreter?: unknown }) =>
    post<{ channel: ChannelRow; key: string }>('/admin/channels', body),
  /** 라벨·해석기만 고친다. 키는 그대로다. */
  updateChannel: (id: string, patch: { label?: string; interpreter?: unknown }) =>
    request<{ channel: ChannelRow }>(`/admin/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  rotateKey: (id: string) => post<{ key: string }>(`/admin/channels/${id}/key`),
  /** 수신만 멈춘다. 채널도 그 채널이 만든 기록도 남는다. */
  disableChannel: (id: string) => post<{ ok: boolean }>(`/admin/channels/${id}/disable`),
  /**
   * 목록에서 없앤다. 참조하는 기록이 있으면 ChannelInUseError를 던지므로,
   * 화면이 몇 건인지 보여주고 확인받은 뒤 purge로 다시 부른다.
   */
  deleteChannel: (id: string, purge = false) =>
    request<{ ok: boolean; removed: { tasks: number; threads: number } }>(
      `/admin/channels/${id}${purge ? '?purge=true' : ''}`,
      { method: 'DELETE' },
    ),
  /** 채널이 제대로 도는지 확인하는 도구. 관리 키로 채널 키 없이 넣는다. */
  inject: (channelId: string, payload: string) =>
    post<{ taskId: string | null; threadId: string | null }>(
      `/admin/channels/${channelId}/events`,
      { payload },
    ),
  /**
   * 관리 화면은 기본이 전체다 — 끝난 것까지 보는 게 이 화면의 목적이다.
   * 그래서 금방 수백 건이 되므로 페이지로 끊는다. total로 페이지 수를 센다.
   */
  tasks: (view: 'active' | 'all' = 'all', limit = 25, offset = 0) =>
    get<{ tasks: TaskSummary[]; total: number }>(
      `/tasks?view=${view}&limit=${limit}&offset=${offset}`,
    ),
  task: (id: string) => get<TaskDetail>(`/tasks/${id}`),
};
