import { describe, expect, it } from 'vitest';
import type { Task } from '@samdi/protocol';
import { AllowAllStartGate, ApprovalStartGate } from './index.js';

const now = new Date().toISOString();
function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    channelId: 'demo',
    label: 'demo',
    payloadRef: 'r1',
    status: 'claimed',
    agent: null,
    threadId: null,
    workerId: 'w1',
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('ApprovalStartGate', () => {
  it('기본은 모두 승인을 받는다', async () => {
    const decision = await new ApprovalStartGate().evaluate(mkTask(), '메일 회신해줘');
    expect(decision.verdict).toBe('ask');
    expect(decision.question).toContain('메일 회신해줘');
  });

  it('면제 라벨은 승인 없이 통과한다', async () => {
    const gate = new ApprovalStartGate({ autoPassLabels: ['reports'] });
    expect((await gate.evaluate(mkTask({ label: 'reports' }), 'x')).verdict).toBe('allow');
    expect((await gate.evaluate(mkTask({ label: 'ops' }), 'x')).verdict).toBe('ask');
  });

  it('면제 채널도 통과한다', async () => {
    const gate = new ApprovalStartGate({ autoPassChannels: ['cron'] });
    expect((await gate.evaluate(mkTask({ channelId: 'cron' }), 'x')).verdict).toBe('allow');
    expect((await gate.evaluate(mkTask({ channelId: 'mail' }), 'x')).verdict).toBe('ask');
  });

  it('정책을 끄면 전부 통과한다', async () => {
    const gate = new ApprovalStartGate({ requireApproval: false });
    expect((await gate.evaluate(mkTask(), 'x')).verdict).toBe('allow');
  });

  it('지시가 비어 있으면 승인 이전에 거부한다', async () => {
    const decision = await new ApprovalStartGate().evaluate(mkTask(), '   ');
    expect(decision.verdict).toBe('deny');
  });

  it('긴 지시는 질문에서 잘라 보여준다', async () => {
    const decision = await new ApprovalStartGate().evaluate(mkTask(), 'x'.repeat(300));
    expect(decision.question!.length).toBeLessThan(200);
    expect(decision.question).toContain('…');
  });
});

describe('AllowAllStartGate', () => {
  it('지시가 있으면 allow', async () => {
    expect((await new AllowAllStartGate().evaluate(mkTask(), '메일 회신해줘')).verdict).toBe('allow');
  });

  it('지시가 비어 있으면 deny — 에이전트에게 넘길 게 없다', async () => {
    const decision = await new AllowAllStartGate().evaluate(mkTask(), '   ');
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('비어');
  });
});
