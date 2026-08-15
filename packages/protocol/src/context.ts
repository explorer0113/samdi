import { z } from 'zod';

/**
 * 문맥 스레드 — 해석기가 유지하는 상태.
 * 수집기가 문맥 키로 이벤트를 여기에 쌓고, 해석기가 스레드를 보고 판정한다.
 *
 * open      수집 중
 * dispatched 해석 완료 → Task 생성됨
 * discarded  noise 판정 → 폐기
 * expired    채널 TTL 동안 새 이벤트 없음 → 종료
 */
export const threadStatusSchema = z.enum(['open', 'dispatched', 'discarded', 'expired']);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const contextThreadSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  /** 같은 키의 이벤트는 같은 스레드에 쌓인다. 소스가 주지 않으면 이벤트마다 새 키. */
  contextKey: z.string(),
  status: threadStatusSchema,
  /** 첫 이벤트가 지정한 에이전트. 분배될 때 Task로 넘어간다. */
  agent: z.string().nullable(),
  /** TTL 만료 판정 기준 */
  lastEventAt: z.string().datetime(),
  /**
   * 쌓인 이벤트 수와 그중 해석을 마친 지점.
   * interpretedSeq < eventSeq 이면 아직 해석하지 않은 이벤트가 있다는 뜻이다.
   * (시각 비교는 같은 밀리초에 들어온 이벤트를 놓치므로 시퀀스를 쓴다.)
   */
  eventSeq: z.number().int().nonnegative(),
  interpretedSeq: z.number().int().nonnegative(),
  /** 마지막으로 해석기를 돌린 시각. null이면 아직 판정 전. */
  lastInterpretedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContextThread = z.infer<typeof contextThreadSchema>;

export const threadEventSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** 자연어 본문 그대로 */
  payload: z.string(),
  receivedAt: z.string().datetime(),
});
export type ThreadEvent = z.infer<typeof threadEventSchema>;

/**
 * 해석기 판정.
 *
 * fast_pass     자기완결적 단순 요청 — 문맥 축적을 기다리지 않고 즉시 분배
 * needs_context 문맥이 더 필요 — 계속 축적 (TTL 만료 시 종료)
 * complete      문맥 완성 — 라벨과 지시를 확정해 분배
 * noise         처리 가치 없음 — 기록만 남기고 폐기
 */
export const interpretVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('fast_pass'),
    label: z.string().min(1),
    /** 에이전트에게 넘길 지시 */
    instruction: z.string().min(1),
  }),
  z.object({ verdict: z.literal('needs_context'), reason: z.string().default('') }),
  z.object({
    verdict: z.literal('complete'),
    label: z.string().min(1),
    instruction: z.string().min(1),
  }),
  z.object({ verdict: z.literal('noise'), reason: z.string().default('') }),
]);
export type InterpretVerdict = z.infer<typeof interpretVerdictSchema>;
