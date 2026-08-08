import { askDecisionResponseSchema, type Task } from '@samdi/protocol';

/**
 * 에이전트 실행 규약.
 * 이 프로젝트는 에이전트 루프를 소유하지 않는다 — Task 컨텍스트를 넘기고
 * 시작시키는 것까지만 어댑터의 책임이다. 완료/실패는 에이전트가
 * Worker의 로컬 보고 API로 직접 보고한다 (의뢰 프롬프트에 보고 지시 포함).
 */
export interface AgentRunRequest {
  task: Task;
  /** triage가 정제한 지시 (없으면 본문 그대로) */
  instruction: string;
  /** Worker가 열어둔 로컬 보고 API 주소. 프롬프트에 포함시킨다. */
  reportUrl: string;
}

export interface AgentAdapter {
  /** 에이전트를 시작시킨다. 시작 실패는 throw, 이후의 성패는 로컬 보고 API로 들어온다. */
  start(request: AgentRunRequest): Promise<void>;
}

/**
 * MVP용 mock: 실제 에이전트 없이 로컬 보고 API로 흐름을 재현한다.
 * 지시에 "승인"이 포함되면 먼저 ask를 보내고, 결정이 돌아올 때까지 기다린다
 * (ask 응답은 사용자가 결정할 때까지 보류된다 — 동기 도구 호출과 같다).
 */
export class MockAgentAdapter implements AgentAdapter {
  async start(request: AgentRunRequest): Promise<void> {
    const post = async (body: unknown) => {
      const res = await fetch(request.reportUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`mock agent report failed: ${res.status}`);
      return res;
    };

    if (request.instruction.includes('승인')) {
      const res = await post({
        type: 'ask',
        question: `"${request.instruction.slice(0, 60)}" — 실행해도 될까요?`,
      });
      const { decision } = askDecisionResponseSchema.parse(await res.json());
      if (decision !== 'approve') return; // 거부 — Worker가 이미 실패 처리했다
    }

    await post({
      type: 'completed',
      summary: `mock: "${request.instruction.slice(0, 80)}" 처리 완료`,
    });
  }
}

export * from './claude-code.js';
export * from './claude-code-terminal.js';
