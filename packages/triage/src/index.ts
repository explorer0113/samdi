import type { Task } from '@samdi/protocol';

/**
 * 1차 판단 에이전트. claim 직후 Worker에서 실행된다.
 * LLM은 반드시 로컬(사용자 기기)에서만 호출한다 — 모델은 설정으로 교체 가능해야 한다.
 */
export interface TriageInput {
  task: Task;
  /** 자연어 본문 그대로 */
  payload: string;
}

export interface TriageResult {
  verdict: 'proceed' | 'drop';
  /** drop 사유 또는 proceed 시 본 에이전트에게 넘길 정제된 지시 */
  reason?: string;
  instruction?: string;
}

export interface TriageAgent {
  evaluate(input: TriageInput): Promise<TriageResult>;
}

/** MVP용: LLM 없이 전부 통과시키고 본문을 지시로 그대로 넘긴다. */
export class PassThroughTriage implements TriageAgent {
  async evaluate(input: TriageInput): Promise<TriageResult> {
    return { verdict: 'proceed', instruction: input.payload };
  }
}
