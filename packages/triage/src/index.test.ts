import { describe, expect, it } from 'vitest';
import type { Task } from '@samdi/protocol';
import { PassThroughTriage } from './index.js';

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

describe('PassThroughTriage', () => {
  it('전부 통과시키고 본문을 지시로 그대로 넘긴다', async () => {
    const result = await new PassThroughTriage().evaluate({ task, payload: '메일 회신해줘' });
    expect(result.verdict).toBe('proceed');
    expect(result.instruction).toBe('메일 회신해줘');
  });
});
