import { z } from 'zod';
import { taskSchema } from './task.js';

/** POST /channels/:channelId/events — 외부 이벤트 수신 (채널 키로 인증) */
export const ingestRequestSchema = z.object({
  /** 자연어 본문 그대로. Control Plane은 해석하지 않는다. */
  payload: z.string().min(1),
  /** 처리할 에이전트를 생성 시점에 지정 (claim 경합 없이 원자적). 생략 시 Worker 기본값. */
  agent: z.string().min(1).optional(),
  /**
   * 문맥 키 — 같은 키의 이벤트는 한 스레드에 쌓인다.
   * 소스 네이티브 키(메일 체인, Slack thread_ts, 이슈 번호)를 발신처가 넣어준다.
   * 생략하면 이벤트마다 새 스레드가 열린다. llm 모드 채널에서만 의미가 있다.
   */
  contextKey: z.string().min(1).optional(),
});
export const ingestResponseSchema = z.object({
  /** Task가 바로 만들어졌으면 그 id. 문맥 스레드에 축적만 됐으면 null. */
  taskId: z.string().nullable(),
  /** llm 모드 채널에서 이벤트가 쌓인 스레드. passthrough면 null. */
  threadId: z.string().nullable(),
});

/** POST /tasks/claim — Worker가 처리할 Task를 원자적으로 가져간다 (Worker API 키로 인증) */
export const claimRequestSchema = z.object({
  workerId: z.string(),
  /** 이 Worker가 처리할 수 있는 라벨 목록 */
  labels: z.array(z.string()).min(1),
  leaseSeconds: z.number().int().positive().max(3600).default(600),
});
export const claimResponseSchema = z.object({
  task: taskSchema.nullable(),
  /** claim 성공 시 본문을 함께 내려준다 (Worker가 별도 fetch하지 않도록) */
  payload: z.string().nullable(),
});

/** POST /tasks/:taskId/report — Worker → Control Plane 진행 보고 */
export const taskReportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rejected'), reason: z.string() }),
  z.object({ type: z.literal('started') }),
  z.object({ type: z.literal('waiting'), question: z.string() }),
  z.object({ type: z.literal('resumed') }),
  z.object({ type: z.literal('completed'), summary: z.string().optional() }),
  z.object({ type: z.literal('failed'), reason: z.string() }),
]);
export type TaskReport = z.infer<typeof taskReportSchema>;

/** POST /tasks/:taskId/agent — 처리할 에이전트 지정 (pending 동안만 가능) */
export const setAgentRequestSchema = z.object({
  agent: z.string().min(1),
});

/** POST /tasks/:taskId/retry — stalled Task의 수동 재시도 승인 (사용자) */
export const retryRequestSchema = z.object({
  action: z.enum(['retry', 'abandon']),
});

/** 목록 표시용: Task + 본문 미리보기 */
export const taskSummarySchema = taskSchema.extend({
  preview: z.string(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** Task 생명주기 전체를 남기는 감사 이벤트 */
export const taskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  at: z.string().datetime(),
  type: z.string(),
  data: z.record(z.unknown()).default({}),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;
