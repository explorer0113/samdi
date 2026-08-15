import type { InterpretVerdict } from '@samdi/protocol';

export interface InterpretInput {
  channelId: string;
  /** 해석기가 고를 수 있는 라벨의 닫힌 집합. 임의 라벨을 만들지 못하게 한다. */
  labels: string[];
  /** 스레드에 쌓인 이벤트, 시간순 */
  events: Array<{ at: string; payload: string }>;
}

export interface Interpreter {
  interpret(input: InterpretInput): Promise<InterpretVerdict>;
}
