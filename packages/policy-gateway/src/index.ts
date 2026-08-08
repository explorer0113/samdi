import type { Task, Verdict } from '@samdi/protocol';
import type { TriageResult } from '@samdi/triage';

/**
 * Start Gate — 이 시스템의 핵심 통제 지점.
 * "이 Task를 시작할 것인가"를 로컬에서 판정한다.
 * 실행 중 정책은 대상 에이전트 자신의 권한 체계에 위임한다.
 */
export interface StartGateDecision {
  verdict: Verdict;
  reason?: string;
}

export interface StartGate {
  evaluate(task: Task, triage: TriageResult): Promise<StartGateDecision>;
}

/** MVP용: triage를 통과한 Task를 전부 허용한다. */
export class AllowAllStartGate implements StartGate {
  async evaluate(_task: Task, triage: TriageResult): Promise<StartGateDecision> {
    if (triage.verdict === 'drop') {
      return { verdict: 'deny', reason: triage.reason ?? 'triage drop' };
    }
    return { verdict: 'allow' };
  }
}
