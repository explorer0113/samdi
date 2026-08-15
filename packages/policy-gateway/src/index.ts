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
  /** ask일 때 사용자에게 보여줄 질문 */
  question?: string;
}

export interface StartGate {
  evaluate(task: Task, instruction: string): Promise<StartGateDecision>;
}

export interface ApprovalPolicy {
  /** 기본적으로 시작 전 사람 승인을 받는다. 끄면 면제 목록과 무관하게 전부 통과. */
  requireApproval: boolean;
  /** 승인 없이 통과시킬 라벨 */
  autoPassLabels: string[];
  /** 승인 없이 통과시킬 채널 */
  autoPassChannels: string[];
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  requireApproval: true,
  autoPassLabels: [],
  autoPassChannels: [],
};

/**
 * 승인 정책 게이트.
 *
 * 기본은 "모두 승인을 받는다"이고, 면제한 채널·라벨만 바로 통과한다.
 * 에이전트가 스스로 물어보길 기대하지 않고 여기서 강제하므로, 어떤 에이전트를
 * 쓰든 동작이 같다.
 */
export class ApprovalStartGate implements StartGate {
  private readonly policy: ApprovalPolicy;

  constructor(policy: Partial<ApprovalPolicy> = {}) {
    this.policy = { ...DEFAULT_APPROVAL_POLICY, ...policy };
  }

  async evaluate(task: Task, instruction: string): Promise<StartGateDecision> {
    if (!instruction.trim()) {
      return { verdict: 'deny', reason: '지시 내용이 비어 있다' };
    }
    if (!this.policy.requireApproval) return { verdict: 'allow' };

    if (this.policy.autoPassChannels.includes(task.channelId)) {
      return { verdict: 'allow', reason: `채널 ${task.channelId}는 승인 면제` };
    }
    if (this.policy.autoPassLabels.includes(task.label)) {
      return { verdict: 'allow', reason: `라벨 ${task.label}은 승인 면제` };
    }

    const preview = instruction.length > 120 ? `${instruction.slice(0, 120)}…` : instruction;
    return {
      verdict: 'ask',
      question: `이 작업을 시작할까요?\n\n${preview}`,
      reason: '승인 정책',
    };
  }
}

/** 승인 없이 전부 통과시킨다 (데모·테스트용). */
export class AllowAllStartGate implements StartGate {
  async evaluate(_task: Task, instruction: string): Promise<StartGateDecision> {
    if (!instruction.trim()) {
      return { verdict: 'deny', reason: '지시 내용이 비어 있다' };
    }
    return { verdict: 'allow' };
  }
}
