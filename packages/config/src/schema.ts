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

export const channelConfigSchema = z.object({
  id: z.string().min(1),
  /** 라우팅 기준. 생략하면 id를 라벨로 쓴다. */
  label: z.string().min(1).optional(),
  /** 웹훅 인증 키 */
  key: z.string().min(1),
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

/** claude-code / claude-code-terminal 어댑터 공통 옵션 */
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
      /** 로컬 보고 API + UI용 API 포트 (루프백 전용) */
      reportPort: z.coerce.number().int().positive().max(65535).default(4700),
    })
    .default({}),
  /** Task에 agent 지정이 없을 때 쓸 에이전트 */
  defaultAgent: z.enum(['mock', 'claude-code', 'claude-code-terminal']).default('mock'),
  agents: z
    .object({
      'claude-code': claudeAgentConfigSchema.default({}),
      'claude-code-terminal': claudeAgentConfigSchema.default({}),
    })
    .default({}),
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
