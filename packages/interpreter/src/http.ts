import { interpretVerdictSchema, type InterpretVerdict } from '@samdi/protocol';
import { buildSystemPrompt } from './claude.js';
import type { InterpretInput, Interpreter } from './types.js';

export interface HttpInterpreterOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  systemPrompt?: string;
  guidance?: string;
}

/**
 * 아무 LLM이나 붙이기 위한 해석기.
 *
 * 설정한 주소로 해석 요청을 POST하고, 판정 JSON을 그대로 돌려받는다.
 * 그 주소 뒤에 무엇을 두든(로컬 모델, 다른 프로바이더, 직접 만든 규칙) 상관하지 않는다.
 *
 * 요청 본문:
 *   { systemPrompt, channelId, labels, events: [{ at, payload }] }
 * 기대하는 응답 (판정 하나):
 *   { "verdict": "fast_pass" | "complete", "label": "...", "instruction": "..." }
 *   { "verdict": "needs_context" | "noise", "reason": "..." }
 *
 * 응답이 규약과 다르면 판정을 지어내지 않고 needs_context로 둔다 — 잘못된 Task를
 * 만드는 것보다 기다리는 편이 안전하다.
 */
export class HttpInterpreter implements Interpreter {
  private readonly systemPrompt: string;

  constructor(private readonly opts: HttpInterpreterOptions) {
    this.systemPrompt = buildSystemPrompt(opts);
  }

  async interpret(input: InterpretInput): Promise<InterpretVerdict> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
      body: JSON.stringify({
        systemPrompt: this.systemPrompt,
        channelId: input.channelId,
        labels: input.labels,
        events: input.events,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      throw new Error(`interpreter endpoint ${res.status}: ${await res.text()}`);
    }

    const parsed = interpretVerdictSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { verdict: 'needs_context', reason: '해석기 응답이 규약과 맞지 않는다' };
    }
    // 라벨 카탈로그를 벗어난 값은 첫 라벨로 되돌린다.
    const verdict = parsed.data;
    if (
      (verdict.verdict === 'fast_pass' || verdict.verdict === 'complete') &&
      !input.labels.includes(verdict.label)
    ) {
      return { ...verdict, label: input.labels[0] ?? input.channelId };
    }
    return verdict;
  }
}
