import type { TaskStatus } from '@samdi/protocol';

/** 허용되는 상태 전이. 여기 없는 전이는 전부 불법이다. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['claimed'],
  // claimed → waiting: Start Gate가 시작 전 승인을 요구한 경우
  claimed: ['running', 'waiting', 'rejected', 'stalled'],
  running: ['waiting', 'completed', 'failed', 'stalled'],
  // waiting → rejected: 시작 전 승인을 거부해 아무것도 실행되지 않은 경우
  // waiting → failed:   실행 중 에이전트의 승인 요청을 거부한 경우
  waiting: ['running', 'rejected', 'failed', 'stalled'],
  // 자동 재배포 금지: stalled에서 벗어나는 길은 사용자의 재시도 승인(pending) 또는 포기(failed)뿐이다.
  stalled: ['pending', 'failed'],
  rejected: [],
  completed: [],
  failed: [],
};

/** 더 이상 아무 일도 일어나지 않는 상태. 진행 중 목록에서 빼는 기준이기도 하다. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['rejected', 'completed', 'failed'];

const TERMINAL = TERMINAL_STATUSES;

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
