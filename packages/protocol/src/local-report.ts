import { z } from 'zod';

/**
 * Worker가 열어두는 로컬 보고 API.
 * 대상 에이전트에게 의뢰할 때 "완료/실패 시 여기에 보고하라"는 지시를 프롬프트에 포함한다.
 * 에이전트 → Worker 방향의 유일한 채널이다.
 */
export const localReportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('completed'), summary: z.string().optional() }),
  z.object({ type: z.literal('failed'), reason: z.string() }),
  /**
   * 사용자 승인이 필요할 때. Task는 waiting 상태로 전환된다.
   * ask는 동기 도구 호출처럼 동작한다 — 사용자가 결정할 때까지 HTTP 응답이
   * 보류되고, 응답 본문으로 askDecisionResponse가 돌아온다.
   */
  z.object({ type: z.literal('ask'), question: z.string() }),
]);
export type LocalReport = z.infer<typeof localReportSchema>;

/** ask 보고의 응답 본문. approve면 에이전트는 계속 진행, deny면 Task는 이미 실패 처리됐다. */
export const askDecisionResponseSchema = z.object({
  decision: z.enum(['approve', 'deny']),
});
export type AskDecision = z.infer<typeof askDecisionResponseSchema>['decision'];
