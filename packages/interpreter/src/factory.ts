import type { InterpreterConfig } from '@samdi/config';
import { ClaudeInterpreter } from './claude.js';
import { HttpInterpreter } from './http.js';
import { PassthroughInterpreter } from './passthrough.js';
import type { Interpreter } from './types.js';

export type InterpreterFactory = (config: InterpreterConfig) => Interpreter;

/**
 * 설정의 mode로 고를 수 있는 내장 해석기.
 *
 * 여기 없는 구현을 쓰려면 Interpreter 인터페이스만 만족시키고
 * createInterpreter의 두 번째 인자로 넘기면 된다 — 이 패키지를 고칠 필요가 없다.
 */
export const builtinInterpreters: Record<string, InterpreterFactory> = {
  passthrough: () => new PassthroughInterpreter(),
  claude: (config) =>
    new ClaudeInterpreter({
      model: config.claude.model,
      effort: config.claude.effort,
      systemPrompt: config.systemPrompt,
      guidance: config.guidance,
    }),
  http: (config) => {
    if (!config.http) {
      throw new Error("interpreter.mode가 'http'이면 interpreter.http.url이 필요하다");
    }
    return new HttpInterpreter({
      url: config.http.url,
      headers: config.http.headers,
      timeoutMs: config.http.timeoutMs,
      systemPrompt: config.systemPrompt,
      guidance: config.guidance,
    });
  },
};

/** 설정대로 해석기를 만든다. custom으로 내장 구현을 덮거나 새 mode를 더할 수 있다. */
export function createInterpreter(
  config: InterpreterConfig,
  custom: Record<string, InterpreterFactory> = {},
): Interpreter {
  const factory = custom[config.mode] ?? builtinInterpreters[config.mode];
  if (!factory) {
    const known = [...new Set([...Object.keys(builtinInterpreters), ...Object.keys(custom)])];
    throw new Error(`unknown interpreter mode: ${config.mode} (${known.join(', ')})`);
  }
  return factory(config);
}
