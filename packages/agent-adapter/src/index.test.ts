import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@samdi/protocol';
import { MockAgentAdapter, type AgentRunRequest } from './index.js';

function mkRequest(instruction: string): AgentRunRequest {
  const now = new Date().toISOString();
  const task: Task = {
    id: 't1',
    channelId: 'demo',
    label: 'demo',
    payloadRef: 'r1',
    status: 'running',
    agent: null,
    workerId: 'w1',
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { task, instruction, reportUrl: 'http://127.0.0.1:4700/report/t1' };
}

/** 로컬 보고 API 흉내: 보낸 본문을 기록하고, ask에는 정해진 결정을 돌려준다 */
function stubReportApi(decision: 'approve' | 'deny') {
  const bodies: Array<{ type: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string };
      bodies.push(body);
      const payload = body.type === 'ask' ? { decision } : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockAgentAdapter', () => {
  it('일반 지시는 바로 completed를 보고한다', async () => {
    const bodies = stubReportApi('approve');
    await new MockAgentAdapter().start(mkRequest('회의 일정 잡아줘'));
    expect(bodies.map((b) => b.type)).toEqual(['completed']);
  });

  it('"승인"이 포함되면 ask 후 approve를 받아야 completed', async () => {
    const bodies = stubReportApi('approve');
    await new MockAgentAdapter().start(mkRequest('계정 삭제 승인 요청'));
    expect(bodies.map((b) => b.type)).toEqual(['ask', 'completed']);
  });

  it('deny를 받으면 completed를 보내지 않는다', async () => {
    const bodies = stubReportApi('deny');
    await new MockAgentAdapter().start(mkRequest('계정 삭제 승인 요청'));
    expect(bodies.map((b) => b.type)).toEqual(['ask']);
  });

  it('보고 API가 오류를 돌려주면 throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(new MockAgentAdapter().start(mkRequest('아무거나'))).rejects.toThrow(
      'mock agent report failed',
    );
  });
});
