import { z } from 'zod';

/**
 * Task 상태 머신 (SOP.md 참조)
 *
 * pending → claimed → running → completed
 *              │         │    ↘ failed
 *              │         ⇄ waiting (승인 대기, 거부 시 failed)
 *              └→ rejected    (Start Gate 기각)
 *
 * 처리 가치 판단(noise)은 Task가 되기 전, 서버의 문맥 스레드에서 끝난다.
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
  /** 이 Task를 낳은 문맥 스레드. passthrough 채널(해석 없이 직행)이면 null. */
  threadId: z.string().nullable(),
  workerId: z.string().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof taskSchema>;

/** Policy Gateway / Start Gate 판정 타입. MVP 구현은 allow/deny만, ask는 프로토콜에 예약. */
export const verdictSchema = z.enum(['allow', 'deny', 'ask']);
export type Verdict = z.infer<typeof verdictSchema>;
