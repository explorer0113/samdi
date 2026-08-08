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
  workerId: 'w1',
  leaseExpiresAt: null,
  createdAt: now,
  updatedAt: now,
};

describe('AllowAllStartGate', () => {
  it('triage 통과분은 allow', async () => {
    const gate = new AllowAllStartGate();
    expect((await gate.evaluate(task, { verdict: 'proceed' })).verdict).toBe('allow');
  });

  it('triage drop은 deny로 이어진다', async () => {
    const gate = new AllowAllStartGate();
    const decision = await gate.evaluate(task, { verdict: 'drop', reason: '스팸' });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toBe('스팸');
  });
});
