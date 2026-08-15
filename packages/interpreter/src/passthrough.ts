import type { InterpretVerdict } from '@samdi/protocol';
import type { InterpretInput, Interpreter } from './types.js';

/**
 * LLM을 쓰지 않는 해석기 — 전부 통과시킨다.
 *
 * 문맥을 판단할 수단이 없으므로 모든 이벤트를 fast_pass로 내보낸다.
 * LLM 없이 운영할 때의 기본값이며, 이 모드에서는 문맥 축적·TTL이 의미가 없다.
 */
export class PassthroughInterpreter implements Interpreter {
  async interpret(input: InterpretInput): Promise<InterpretVerdict> {
    const instruction = input.events.map((e) => e.payload).join('\n\n');
    return {
      verdict: 'fast_pass',
      label: input.labels[0] ?? input.channelId,
      instruction: instruction || '(빈 이벤트)',
    };
  }
}
