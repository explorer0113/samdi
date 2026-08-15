import type { Task, Verdict } from '@samdi/protocol';

/**
 * Start Gate — 이 시스템의 핵심 통제 지점.
 * "이 Task를 시작할 것인가"를 사용자 기기에서 판정한다.
 *
 * 해석·분류는 서버가 이미 끝냈으므로 여기서 LLM을 쓰지 않는다 — 규칙 기반이다.
 * 실행 중 정책은 대상 에이전트 자신의 권한 체계에 위임한다.
 */
export interface StartGateDecision {
  verdict: Verdict;
  reason?: string;
}

export interface StartGate {
  evaluate(task: Task, instruction: string): Promise<StartGateDecision>;
}

/** MVP용: 라벨이 이 Worker의 담당이면 허용한다. */
export class AllowAllStartGate implements StartGate {
  async evaluate(_task: Task, instruction: string): Promise<StartGateDecision> {
    if (!instruction.trim()) {
      return { verdict: 'deny', reason: '지시 내용이 비어 있다' };
    }
    return { verdict: 'allow' };
  }
}
