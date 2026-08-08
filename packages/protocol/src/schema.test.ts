import { describe, expect, it } from 'vitest';
import {
  askDecisionResponseSchema,
  claimRequestSchema,
  ingestRequestSchema,
  localReportSchema,
  taskReportSchema,
} from './index.js';

describe('claimRequestSchema', () => {
  it('leaseSeconds를 생략하면 600', () => {
    const parsed = claimRequestSchema.parse({ workerId: 'w1', labels: ['demo'] });
    expect(parsed.leaseSeconds).toBe(600);
  });

  it('빈 라벨 목록은 거부', () => {
    expect(() => claimRequestSchema.parse({ workerId: 'w1', labels: [] })).toThrow();
  });

  it('1시간 초과 lease는 거부', () => {
    expect(() =>
      claimRequestSchema.parse({ workerId: 'w1', labels: ['demo'], leaseSeconds: 7200 }),
    ).toThrow();
  });
});

describe('taskReportSchema', () => {
  it('failed는 reason이 필수', () => {
    expect(() => taskReportSchema.parse({ type: 'failed' })).toThrow();
    expect(taskReportSchema.parse({ type: 'failed', reason: 'x' }).type).toBe('failed');
  });

  it('waiting은 question이 필수', () => {
    expect(() => taskReportSchema.parse({ type: 'waiting' })).toThrow();
  });

  it('모르는 type은 거부', () => {
    expect(() => taskReportSchema.parse({ type: 'paused' })).toThrow();
  });
});

describe('localReportSchema', () => {
  it('ask는 question이 필수', () => {
    expect(() => localReportSchema.parse({ type: 'ask' })).toThrow();
    expect(localReportSchema.parse({ type: 'ask', question: '?' }).type).toBe('ask');
  });

  it('completed는 summary가 선택', () => {
    expect(localReportSchema.parse({ type: 'completed' }).type).toBe('completed');
  });
});

describe('askDecisionResponseSchema', () => {
  it('approve/deny만 허용', () => {
    expect(askDecisionResponseSchema.parse({ decision: 'approve' }).decision).toBe('approve');
    expect(() => askDecisionResponseSchema.parse({ decision: 'maybe' })).toThrow();
  });
});

describe('ingestRequestSchema', () => {
  it('빈 본문은 거부', () => {
    expect(() => ingestRequestSchema.parse({ payload: '' })).toThrow();
  });
});
