import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// SDK의 구조화 출력 헬퍼는 zod v4 타입을 요구한다 (zod 3.25의 v4 서브패스).
// 프로젝트의 다른 스키마는 계속 zod v3를 쓴다 — 여기서만 갈린다.
import * as z from 'zod/v4';
import type { InterpretVerdict } from '@samdi/protocol';
import type { InterpretInput, Interpreter } from './types.js';

export interface ClaudeInterpreterOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * 기본 프롬프트를 통째로 대체한다.
   * 판정 4종의 의미는 파이프라인이 의존하는 계약이므로, 대체할 때도 그대로 유지해야 한다.
   */
  systemPrompt?: string;
  /** 기본 프롬프트 뒤에 덧붙일 채널별 맥락. 대체가 아니라 추가다. */
  guidance?: string;
  /** 주입용 (테스트). 생략하면 환경에서 자격 증명을 찾는다. */
  client?: Anthropic;
}

/**
 * 기본 해석 프롬프트.
 * 설정에서 통째로 바꿀 수 있지만(`interpreter.systemPrompt`), 보통은 채널별 맥락만
 * 덧붙이면 된다(`interpreter.guidance`).
 */
export const DEFAULT_INTERPRETER_PROMPT = `너는 들어온 이벤트가 AI 에이전트에게 맡길 작업이 되는지 판정한다.

판정은 넷 중 하나다.
- fast_pass: 그 자체로 완결된 단순 요청. 뒤따를 맥락을 기다릴 필요가 없다.
- complete: 여러 이벤트가 쌓여 이제 무엇을 해야 할지 확정됐다.
- needs_context: 아직 요청이 무엇인지 특정할 수 없다. 후속 이벤트를 기다린다.
- noise: 처리할 가치가 없다. 자동 알림, 인사, 광고 등.

fast_pass나 complete일 때는 주어진 라벨 목록에서 하나를 고르고, 에이전트가 그대로
수행할 수 있는 지시문을 쓴다. 지시문은 원문을 옮기는 게 아니라, 흩어진 맥락을 모아
무엇을 해야 하는지 한 덩어리로 정리한 것이어야 한다.

라벨은 반드시 주어진 목록 안에서 고른다.`;

/** 기본(또는 대체) 프롬프트에 채널별 맥락을 덧붙인다. */
export function buildSystemPrompt(opts: { systemPrompt?: string; guidance?: string } = {}): string {
  const base = opts.systemPrompt?.trim() || DEFAULT_INTERPRETER_PROMPT;
  const guidance = opts.guidance?.trim();
  return guidance ? `${base}\n\n## 이 채널에 대해\n\n${guidance}` : base;
}

function buildSchema(labels: string[]) {
  const labelEnum =
    labels.length > 0 ? z.enum(labels as [string, ...string[]]) : z.string();
  return z.object({
    verdict: z.enum(['fast_pass', 'needs_context', 'complete', 'noise']),
    /** needs_context·noise일 때는 무시된다 */
    label: labelEnum,
    /** needs_context·noise일 때는 빈 문자열 */
    instruction: z.string(),
    /** 판정 근거 한 줄 */
    reason: z.string(),
  });
}

/**
 * Claude 기반 해석기. 서버(Control Plane)에서 이벤트당 한 번만 돈다.
 *
 * 분류 작업이므로 구조화 출력으로 판정을 강제하고, effort는 낮게 잡는다.
 * 자격 증명은 표준 경로(ANTHROPIC_API_KEY 또는 `ant auth login` 프로필)에서 찾는다.
 */
export class ClaudeInterpreter implements Interpreter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeInterpreterOptions['effort']>;
  private readonly systemPrompt: string;

  constructor(opts: ClaudeInterpreterOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? 'claude-opus-5';
    this.effort = opts.effort ?? 'low';
    this.systemPrompt = buildSystemPrompt(opts);
  }

  async interpret(input: InterpretInput): Promise<InterpretVerdict> {
    const labels = input.labels.length > 0 ? input.labels : [input.channelId];
    const transcript = input.events
      .map((e, i) => `[${i + 1}] ${e.at}\n${e.payload}`)
      .join('\n\n');

    const schema = buildSchema(labels);
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4096,
      system: this.systemPrompt,
      output_config: { format: zodOutputFormat(schema), effort: this.effort },
      messages: [
        {
          role: 'user',
          content: `고를 수 있는 라벨: ${labels.join(', ')}\n\n스레드에 쌓인 이벤트:\n\n${transcript}`,
        },
      ],
    });

    const parsed = schema.safeParse(response.parsed_output);
    if (!parsed.success) {
      // 구조화 출력이 실패하면 판정을 지어내지 않는다 — 더 기다린다.
      return { verdict: 'needs_context', reason: '해석기 응답을 파싱하지 못했다' };
    }
    return toVerdict(parsed.data);
  }
}

function toVerdict(parsed: {
  verdict: string;
  label: string;
  instruction: string;
  reason: string;
}): InterpretVerdict {
  switch (parsed.verdict) {
    case 'fast_pass':
    case 'complete': {
      // 지시가 비면 분배해도 에이전트가 할 일이 없다 — 더 기다리는 편이 낫다.
      if (!parsed.instruction.trim()) {
        return { verdict: 'needs_context', reason: '지시문이 비어 있다' };
      }
      // 라벨은 구조화 출력의 enum이 카탈로그 안으로 강제한다 (벗어나면 위 safeParse에서 걸린다).
      return {
        verdict: parsed.verdict === 'fast_pass' ? 'fast_pass' : 'complete',
        label: parsed.label,
        instruction: parsed.instruction,
      };
    }
    case 'noise':
      return { verdict: 'noise', reason: parsed.reason };
    default:
      return { verdict: 'needs_context', reason: parsed.reason };
  }
}
