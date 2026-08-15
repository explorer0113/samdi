import { describe, expect, it } from 'vitest';
import type { Task } from '@samdi/protocol';
import { AllowAllStartGate } from './index.js';

const now = new Date().toISOString();
const task: Task = {
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
};

describe('AllowAllStartGate', () => {
  it('지시가 있으면 allow', async () => {
    const gate = new AllowAllStartGate();
    expect((await gate.evaluate(task, '메일 회신해줘')).verdict).toBe('allow');
  });

  it('지시가 비어 있으면 deny — 에이전트에게 넘길 게 없다', async () => {
    const gate = new AllowAllStartGate();
    const decision = await gate.evaluate(task, '   ');
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('비어');
  });
});
