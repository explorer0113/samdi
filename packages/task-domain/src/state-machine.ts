import type { TaskStatus } from '@samdi/protocol';

/** 허용되는 상태 전이. 여기 없는 전이는 전부 불법이다. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['claimed'],
  claimed: ['running', 'triaged_out', 'rejected', 'stalled'],
  running: ['waiting', 'completed', 'failed', 'stalled'],
  waiting: ['running', 'failed', 'stalled'],
  // 자동 재배포 금지: stalled에서 벗어나는 길은 사용자의 재시도 승인(pending) 또는 포기(failed)뿐이다.
  stalled: ['pending', 'failed'],
  triaged_out: [],
  rejected: [],
  completed: [],
  failed: [],
};

const TERMINAL: readonly TaskStatus[] = ['triaged_out', 'rejected', 'completed', 'failed'];

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
