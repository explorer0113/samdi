import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * 설정 스키마.
 *
 * 모든 키에 기본값이 있으므로 설정 파일이 없어도 동작한다 (제로 설정 실행).
 * 숫자는 z.coerce로 받아 env 문자열도 그대로 검증된다.
 * 사람이 읽는 설명은 docs/configuration.md에 있다 — 키를 추가하면 그 문서도 함께 갱신할 것.
 */

/** `~`를 홈 디렉토리로 펼친다. YAML에 `~/.samdi/...`를 쓸 수 있게. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const pathString = z.string().min(1).transform(expandHome);

/** YAML 배열(`[demo, ops]`)과 env 문자열(`demo,ops`)을 모두 받는다. */
const labelsSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, { message: '라벨이 비어 있다' }),
]);

/**
 * 채널별 해석기 설정.
 *
 * passthrough — LLM을 쓰지 않는다. 이벤트 하나가 곧 Task 하나(채널 라벨 그대로).
 *               문맥 스레드도 만들지 않는다. 기본값이며, LLM 없이 돌리려면 이걸 쓴다.
 * 그 외      — 이벤트를 문맥 스레드에 쌓고 해당 해석기가 판정한다.
 *
 * 해석기는 인터페이스(@samdi/interpreter의 Interpreter)로 열려 있다. 내장 구현은
 * claude와 http 둘이고, 다른 구현을 쓰려면 createInterpreter에 팩토리를 넘기면 된다.
 */
/** mode: claude — 내장 Anthropic 구현 */
export const claudeInterpreterConfigSchema = z
  .object({
    model: z.string().min(1).default('claude-opus-5'),
    /** 분류는 가벼운 작업이라 낮은 effort로 충분하다 */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  })
  .default({});

/**
 * mode: http — 아무 LLM이나 붙이기 위한 탈출구.
 * 설정한 주소로 해석 요청을 POST하고, 판정 JSON을 그대로 돌려받는다.
 * 로컬 모델(Ollama 등)이든 다른 프로바이더든 이 규약만 맞추면 된다.
 */
export const httpInterpreterConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});

export const interpreterConfigSchema = z
  .object({
    /**
     * 이 채널을 어떤 해석기로 처리할지.
     * passthrough — LLM 미사용. 이벤트 하나가 곧 Task 하나.
     * claude      — 내장 Anthropic 구현.
     * http        — 설정한 주소에 위임 (아무 LLM이나).
     */
    mode: z.enum(['passthrough', 'claude', 'http']).default('passthrough'),
    /** 이 시간 동안 새 이벤트가 없으면 스레드를 expired로 닫는다 */
    ttlSeconds: z.coerce.number().int().positive().default(3600),
    /** 이벤트가 붙은 뒤 이만큼 잠잠해야 해석기를 돌린다 (연속 유입 시 호출 낭비 방지) */
    debounceMs: z.coerce.number().int().nonnegative().default(2000),
    /** 해석기가 고를 수 있는 라벨의 닫힌 집합. 비우면 채널 라벨 하나만 쓴다. */
    labels: z.array(z.string().min(1)).default([]),
    /** 프로바이더별 설정 — mode에 해당하는 블록만 쓰인다 */
    claude: claudeInterpreterConfigSchema,
    http: httpInterpreterConfigSchema.optional(),
    /**
     * 기본 프롬프트 뒤에 덧붙일 이 채널의 맥락.
     * "이 채널은 고객 지원 메일이다", "견적 문의는 ops로" 같은 도메인 지식을 여기 쓴다.
     * 대부분의 조정은 이걸로 충분하다.
     */
    guidance: z.string().optional(),
    /**
     * 기본 프롬프트를 통째로 대체한다 (탈출구).
     * 판정 4종(fast_pass·needs_context·complete·noise)의 의미는 파이프라인이 의존하는
     * 계약이므로, 대체하더라도 그 의미는 그대로 설명해야 한다.
     */
    systemPrompt: z.string().min(1).optional(),
  })
  .default({});
export type InterpreterConfig = z.infer<typeof interpreterConfigSchema>;

export const channelConfigSchema = z.object({
  id: z.string().min(1),
  /** 라우팅 기준. 생략하면 id를 라벨로 쓴다. */
  label: z.string().min(1).optional(),
  /** 웹훅 인증 키 */
  key: z.string().min(1),
  interpreter: interpreterConfigSchema,
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const serverConfigSchema = z.object({
  port: z.coerce.number().int().positive().max(65535).default(3000),
  host: z.string().min(1).default('127.0.0.1'),
  dbPath: pathString.default('samdi.sqlite'),
  /** Worker/관리 요청 공용 키. 개별 Worker 등록·발급은 이후 단계. */
  workerKey: z.string().min(1).default('demo-worker-key'),
  /** lease 만료 스캔 주기 (stalled로 옮기는 주기) */
  sweepIntervalMs: z.coerce.number().int().positive().default(30_000),
  /** 시작 시 DB로 동기화되는 채널 목록 */
  channels: z.array(channelConfigSchema).default([
    { id: 'demo', label: 'demo', key: 'demo-channel-key' },
  ]),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

/** claude-code 어댑터 옵션 */
export const claudeAgentConfigSchema = z.object({
  /** 생략 시 PATH의 `claude` */
  bin: z.string().min(1).optional(),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
    .optional(),
  /** 보고용 curl은 최소한 허용해야 한다 */
  allowedTools: z.string().min(1).default('Bash(curl *)'),
  /** 에이전트 작업 디렉토리. 고정 경로여야 폴더 신뢰 수락이 재사용된다. */
  cwd: pathString.optional(),
  /** headless 실행 타임아웃 (terminal 어댑터는 무시) */
  timeoutMs: z.coerce.number().int().positive().default(600_000),
});
export type ClaudeAgentConfig = z.infer<typeof claudeAgentConfigSchema>;

export const workerConfigSchema = z.object({
  controlPlane: z
    .object({
      url: z.string().url().default('http://127.0.0.1:3000'),
      workerKey: z.string().min(1).default('demo-worker-key'),
      /** 데모 이벤트 주입(UI/CLI)에만 쓰는 채널 키 */
      channelKey: z.string().min(1).default('demo-channel-key'),
    })
    .default({}),
  worker: z
    .object({
      id: z.string().min(1).default('worker-1'),
      labels: labelsSchema.default(['demo']),
      pollIntervalMs: z.coerce.number().int().positive().default(2000),
      leaseSeconds: z.coerce.number().int().positive().max(3600).default(600),
      /** 로컬 보고 API + UI용 API 포트 */
      reportPort: z.coerce.number().int().positive().max(65535).default(4700),
      /**
       * 보고 API를 바인드할 주소. 기본은 루프백 전용이다 —
       * 보고 API에는 인증이 없으므로 기기 밖에서 닿으면 안 된다.
       *
       * 컨테이너 안에서는 네임스페이스가 격리돼 있어 0.0.0.0으로 열어야 하고,
       * 대신 호스트 쪽에서 `-p 127.0.0.1:4700:4700`으로 루프백에만 노출한다.
       */
      reportHost: z.string().min(1).default('127.0.0.1'),
      /**
       * 동시에 처리할 Task 수.
       * 1이면 앞선 Task가 끝나야 다음을 집는다 — 터미널 에이전트처럼 사람을
       * 기다리는 작업이 있으면 그 뒤가 전부 밀린다.
       */
      concurrency: z.coerce.number().int().positive().max(32).default(1),
    })
    .default({}),
  /**
   * Start Gate 정책 — 시작 전에 사람 승인을 받을지.
   *
   * 기본은 모두 승인을 받는다. 에이전트가 스스로 물어보길 기대하지 않고 여기서
   * 강제하므로 어떤 에이전트를 쓰든 동작이 같다. 면제할 채널·라벨만 나열한다.
   */
  startGate: z
    .object({
      requireApproval: z.boolean().default(true),
      autoPassLabels: z.array(z.string().min(1)).default([]),
      autoPassChannels: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  /**
   * 빌드된 worker-ui(dist)를 서빙할 경로. 있으면 Worker가 `/`로 직접 내보낸다.
   * 개발 중에는 vite 개발 서버를 쓰므로 비워두고, 컨테이너에서는 이미지에 구운
   * dist 경로를 준다 — UI와 API가 같은 출처라 프록시 설정이 필요 없다.
   */
  uiDist: pathString.optional(),
  /** Task에 agent 지정이 없을 때 쓸 에이전트 */
  defaultAgent: z.enum(['mock', 'claude-code']).default('mock'),
  agents: z
    .object({
      'claude-code': claudeAgentConfigSchema.default({}),
    })
    .default({}),
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
