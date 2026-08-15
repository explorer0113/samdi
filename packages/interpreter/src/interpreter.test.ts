import type Anthropic from '@anthropic-ai/sdk';
import { interpreterConfigSchema } from '@samdi/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeInterpreter,
  DEFAULT_INTERPRETER_PROMPT,
  buildSystemPrompt,
} from './claude.js';
import { createInterpreter } from './factory.js';
import { HttpInterpreter } from './http.js';
import { PassthroughInterpreter } from './passthrough.js';
import type { InterpretInput } from './types.js';

const input: InterpretInput = {
  channelId: 'mail',
  labels: ['inbox', 'coding'],
  events: [{ at: '2026-01-01T00:00:00.000Z', payload: '로그인이 안 돼요' }],
};

/** messages.parse만 흉내내는 가짜 클라이언트 */
function fakeClient(parsedOutput: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { parsed_output: parsedOutput };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildSystemPrompt', () => {
  it('아무것도 안 주면 기본 프롬프트', () => {
    expect(buildSystemPrompt()).toBe(DEFAULT_INTERPRETER_PROMPT);
  });

  it('guidance는 기본 프롬프트에 덧붙는다 (대체가 아니다)', () => {
    const prompt = buildSystemPrompt({ guidance: '광고성 메일은 noise다.' });
    expect(prompt).toContain(DEFAULT_INTERPRETER_PROMPT);
    expect(prompt).toContain('광고성 메일은 noise다.');
  });

  it('systemPrompt는 기본 프롬프트를 대체한다', () => {
    const prompt = buildSystemPrompt({ systemPrompt: '완전히 다른 지시' });
    expect(prompt).toBe('완전히 다른 지시');
    expect(prompt).not.toContain('판정은 넷 중 하나다');
  });

  it('대체 프롬프트에도 guidance는 덧붙는다', () => {
    const prompt = buildSystemPrompt({ systemPrompt: '기반', guidance: '추가' });
    expect(prompt).toContain('기반');
    expect(prompt).toContain('추가');
  });
});

describe('ClaudeInterpreter', () => {
  it('설정한 프롬프트·모델·effort로 호출한다', async () => {
    const { client, calls } = fakeClient({
      verdict: 'complete',
      label: 'coding',
      instruction: '로그인 버그를 고쳐라',
      reason: '',
    });
    const interpreter = new ClaudeInterpreter({
      client,
      model: 'claude-sonnet-5',
      effort: 'medium',
      guidance: '이 채널은 버그 신고다.',
    });

    const verdict = await interpreter.interpret(input);

    expect(verdict).toEqual({
      verdict: 'complete',
      label: 'coding',
      instruction: '로그인 버그를 고쳐라',
    });
    expect(calls[0]?.model).toBe('claude-sonnet-5');
    expect((calls[0]?.output_config as { effort: string }).effort).toBe('medium');
    expect(calls[0]?.system).toContain('이 채널은 버그 신고다.');
  });

  it('라벨 카탈로그를 벗어난 응답은 판정으로 인정하지 않는다', async () => {
    // 구조화 출력의 enum이 카탈로그 밖 라벨을 막지만, 뚫렸을 때도 Task를 만들지 않는다
    const { client } = fakeClient({
      verdict: 'fast_pass',
      label: 'made-up',
      instruction: '해줘',
      reason: '',
    });
    const verdict = await new ClaudeInterpreter({ client }).interpret(input);
    expect(verdict.verdict).toBe('needs_context');
  });

  it('지시문이 비면 분배하지 않고 더 기다린다', async () => {
    const { client } = fakeClient({ verdict: 'complete', label: 'inbox', instruction: '  ', reason: '' });
    const verdict = await new ClaudeInterpreter({ client }).interpret(input);
    expect(verdict.verdict).toBe('needs_context');
  });

  it('응답이 스키마와 맞지 않으면 판정을 지어내지 않는다', async () => {
    const { client } = fakeClient({ nonsense: true });
    const verdict = await new ClaudeInterpreter({ client }).interpret(input);
    expect(verdict.verdict).toBe('needs_context');
  });

  it('noise 판정은 사유와 함께 그대로 전달된다', async () => {
    const { client } = fakeClient({
      verdict: 'noise',
      label: 'inbox',
      instruction: '',
      reason: '자동 알림',
    });
    expect(await new ClaudeInterpreter({ client }).interpret(input)).toEqual({
      verdict: 'noise',
      reason: '자동 알림',
    });
  });
});

describe('HttpInterpreter', () => {
  it('설정한 주소로 프롬프트·이벤트를 보내고 판정을 받는다', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ verdict: 'complete', label: 'coding', instruction: '고쳐라' }),
          { status: 200 },
        );
      }),
    );

    const verdict = await new HttpInterpreter({
      url: 'http://127.0.0.1:9/interpret',
      guidance: '버그 신고 채널',
    }).interpret(input);

    expect(verdict).toEqual({ verdict: 'complete', label: 'coding', instruction: '고쳐라' });
    expect(sent.labels).toEqual(['inbox', 'coding']);
    expect(sent.events).toEqual(input.events);
    expect(String(sent.systemPrompt)).toContain('버그 신고 채널');
  });

  it('규약과 다른 응답이면 needs_context로 둔다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answer: '몰라요' }), { status: 200 })),
    );
    const verdict = await new HttpInterpreter({ url: 'http://127.0.0.1:9/x' }).interpret(input);
    expect(verdict.verdict).toBe('needs_context');
  });

  it('엔드포인트 오류는 throw한다 — 파이프라인이 재시도한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(
      new HttpInterpreter({ url: 'http://127.0.0.1:9/x' }).interpret(input),
    ).rejects.toThrow('interpreter endpoint 500');
  });
});

describe('createInterpreter', () => {
  const cfg = (over: Record<string, unknown>) => interpreterConfigSchema.parse(over);

  it('mode로 내장 구현을 고른다', () => {
    expect(createInterpreter(cfg({ mode: 'passthrough' }))).toBeInstanceOf(PassthroughInterpreter);
    expect(createInterpreter(cfg({ mode: 'claude' }))).toBeInstanceOf(ClaudeInterpreter);
    expect(
      createInterpreter(cfg({ mode: 'http', http: { url: 'http://x.test/i' } })),
    ).toBeInstanceOf(HttpInterpreter);
  });

  it('http 모드인데 url이 없으면 시작할 때 알려준다', () => {
    expect(() => createInterpreter(cfg({ mode: 'http' }))).toThrowError(/interpreter\.http\.url/);
  });

  it('직접 만든 해석기를 끼워넣을 수 있다', async () => {
    const mine = { interpret: async () => ({ verdict: 'noise' as const, reason: '내 규칙' }) };
    const interpreter = createInterpreter(cfg({ mode: 'passthrough' }), {
      passthrough: () => mine,
    });
    expect(await interpreter.interpret(input)).toEqual({ verdict: 'noise', reason: '내 규칙' });
  });
});
