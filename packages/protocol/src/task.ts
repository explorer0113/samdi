import { z } from 'zod';

/**
 * Task 상태 머신 (SOP.md 참조)
 *
 * pending → claimed → running → completed
 *              │         │    ↘ failed
 *              │         ⇄ waiting (승인 대기, 거부 시 failed)
 *              ├→ triaged_out (Triage 기각)
 *              └→ rejected    (Start Gate 기각)
 *
 * claimed / running / waiting ─(lease 만료)→ stalled
 * stalled ─(사용자 재시도 승인)→ pending
 * stalled ─(사용자 포기)→ failed
 */
export const taskStatusSchema = z.enum([
  'pending',
  'claimed',
  'running',
  'waiting',
  'stalled',
  'triaged_out',
  'rejected',
  'completed',
  'failed',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  /** 라우팅·claim 필터 기준. 채널 등록 시 부여된다. */
  label: z.string(),
  /** 본문(자연어 페이로드)은 PayloadStore에 있고 Task는 참조만 갖는다. */
  payloadRef: z.string(),
  status: taskStatusSchema,
  /** 이 Task를 처리할 에이전트 이름. null이면 Worker의 기본 에이전트. pending 동안만 변경 가능. */
  agent: z.string().nullable(),
  workerId: z.string().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof taskSchema>;

/** Policy Gateway / Start Gate 판정 타입. MVP 구현은 allow/deny만, ask는 프로토콜에 예약. */
export const verdictSchema = z.enum(['allow', 'deny', 'ask']);
export type Verdict = z.infer<typeof verdictSchema>;
