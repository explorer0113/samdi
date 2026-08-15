import { describe, expect, it } from 'vitest';
import type { Task, TaskReport } from '@samdi/protocol';
import type { AgentAdapter } from '@samdi/agent-adapter';
import { AllowAllStartGate, ApprovalStartGate } from '@samdi/policy-gateway';
import { ActivityLog } from './activity-log.js';
import { Worker, type WorkerClient, type WorkerDeps } from './worker.js';

const noopLog = { info: () => {}, error: () => {} };

function mkTask(id = 'task-1', agent: string | null = null): Task {
  const now = new Date().toISOString();
  return {
    id,
    channelId: 'demo',
    label: 'demo',
    payloadRef: 'ref-1',
    status: 'claimed',
    agent,
    threadId: null,
    workerId: 'w1',
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** claim 한 번에 task 하나를 내주고, 이후 보고를 전부 기록하는 fake Control Plane */
function mkClient(tasks: Array<Task | null>) {
  const reports: TaskReport[] = [];
  const client: WorkerClient = {
    claim: async () => {
      const task = tasks.shift() ?? null;
      return { task, payload: task ? '본문' : null };
    },
    report: async (_taskId, report) => {
      reports.push(report);
    },
  };
  return { client, reports };
}

function mkWorker(overrides: Partial<WorkerDeps>): Worker {
  const deps: WorkerDeps = {
    client: mkClient([]).client,
    gate: new AllowAllStartGate(),
    adapters: { mock: { start: async () => {} } },
    defaultAgent: 'mock',
    activity: new ActivityLog(),
    workerId: 'w1',
    labels: ['demo'],
    leaseSeconds: 0.2, // 테스트에선 200ms lease
    reportBaseUrl: 'http://127.0.0.1:0',
    log: noopLog,
    ...overrides,
  };
  return new Worker(deps);
}

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condition timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Worker.processOne', () => {
  it('claim할 게 없으면 false', async () => {
    const { client } = mkClient([null]);
    const worker = mkWorker({ client });
    expect(await worker.processOne()).toBe(false);
  });

  it('정상 경로: started → completed 보고', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let workerRef!: Worker;
    const adapter: AgentAdapter = {
      start: async (req) => {
        workerRef.handleLocalReport(req.task.id, { type: 'completed', summary: 'ok' });
      },
    };
    workerRef = mkWorker({ client, adapters: { mock: adapter } });
    expect(await workerRef.processOne()).toBe(true);
    expect(reports.map((r) => r.type)).toEqual(['started', 'completed']);
    expect(workerRef.current).toHaveLength(0);
  });

  it('task.agent로 어댑터를 선택한다', async () => {
    const { client, reports } = mkClient([mkTask('task-1', 'special')]);
    const used: string[] = [];
    let workerRef!: Worker;
    const mk = (name: string): AgentAdapter => ({
      start: async (req) => {
        used.push(name);
        workerRef.handleLocalReport(req.task.id, { type: 'completed' });
      },
    });
    workerRef = mkWorker({
      client,
      adapters: { mock: mk('mock'), special: mk('special') },
    });
    await workerRef.processOne();
    expect(used).toEqual(['special']);
    expect(reports.map((r) => r.type)).toEqual(['started', 'completed']);
  });

  it('모르는 agent 이름이면 기본 어댑터로 폴백한다', async () => {
    const { client } = mkClient([mkTask('task-1', 'no-such-agent')]);
    const used: string[] = [];
    let workerRef!: Worker;
    workerRef = mkWorker({
      client,
      adapters: {
        mock: {
          start: async (req) => {
            used.push('mock');
            workerRef.handleLocalReport(req.task.id, { type: 'completed' });
          },
        },
      },
    });
    await workerRef.processOne();
    expect(used).toEqual(['mock']);
  });

  it('Start Gate deny → rejected 보고', async () => {
    const { client, reports } = mkClient([mkTask()]);
    const worker = mkWorker({
      client,
      gate: { evaluate: async () => ({ verdict: 'deny', reason: '정책' }) },
    });
    await worker.processOne();
    expect(reports.map((r) => r.type)).toEqual(['rejected']);
  });

  it('adapter 시작 실패 → failed 보고', async () => {
    const { client, reports } = mkClient([mkTask()]);
    const worker = mkWorker({
      client,
      adapters: {
        mock: {
          start: async () => {
            throw new Error('boom');
          },
        },
      },
    });
    await worker.processOne();
    expect(reports.map((r) => r.type)).toEqual(['started', 'failed']);
  });

  it('lease 내 보고 없음 → 추가 보고 없이 넘어간다 (sweep에 맡김)', async () => {
    const { client, reports } = mkClient([mkTask()]);
    const worker = mkWorker({ client, leaseSeconds: 0.05 });
    await worker.processOne();
    expect(reports.map((r) => r.type)).toEqual(['started']);
  });

  it('ask → 승인 → resumed 후 완료까지 이어진다', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let workerRef!: Worker;
    const adapter: AgentAdapter = {
      start: async (req) => {
        const res = workerRef.handleLocalReport(req.task.id, {
          type: 'ask',
          question: '실행할까요?',
        });
        if (!res.ok || !res.decision) throw new Error('ask not accepted');
        const decision = await res.decision; // 사용자 결정까지 보류되는 동기 ask
        if (decision === 'approve') {
          workerRef.handleLocalReport(req.task.id, { type: 'completed', summary: 'ok' });
        }
      },
    };
    workerRef = mkWorker({ client, adapters: { mock: adapter }, leaseSeconds: 2 });

    const done = workerRef.processOne();
    await until(() => workerRef.approvals.length > 0);
    expect(workerRef.approvals[0]?.question).toBe('실행할까요?');
    expect(workerRef.current[0]?.phase).toBe('awaiting_approval');
    expect(workerRef.decide('task-1', 'approve')).toBe(true);
    await done;

    expect(reports.map((r) => r.type)).toEqual(['started', 'waiting', 'resumed', 'completed']);
    expect(workerRef.approvals).toHaveLength(0);
  });

  it('ask → 거부 → failed로 마감, 에이전트는 deny를 받는다', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let agentDecision: string | null = null;
    let workerRef!: Worker;
    const adapter: AgentAdapter = {
      start: async (req) => {
        const res = workerRef.handleLocalReport(req.task.id, { type: 'ask', question: '?' });
        if (!res.ok || !res.decision) throw new Error('ask not accepted');
        agentDecision = await res.decision;
      },
    };
    workerRef = mkWorker({ client, adapters: { mock: adapter }, leaseSeconds: 2 });

    const done = workerRef.processOne();
    await until(() => workerRef.approvals.length > 0);
    workerRef.decide('task-1', 'deny');
    await done;

    expect(reports.map((r) => r.type)).toEqual(['started', 'waiting', 'failed']);
    expect(agentDecision).toBe('deny');
  });

  it('시작 전 승인: 게이트가 ask면 에이전트를 띄우기 전에 멈춘다', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let started = false;
    let workerRef!: Worker;
    workerRef = mkWorker({
      client,
      gate: new ApprovalStartGate(), // 기본: 모두 승인 필요
      adapters: {
        mock: {
          start: async (req) => {
            started = true;
            workerRef.handleLocalReport(req.task.id, { type: 'completed' });
          },
        },
      },
      leaseSeconds: 2,
    });

    const done = workerRef.processOne();
    await until(() => workerRef.approvals.length > 0);
    // 아직 에이전트는 실행되지 않았다 — 이게 mock/실제 에이전트 무관하게 동작하는 이유다
    expect(started).toBe(false);
    expect(workerRef.approvals[0]?.question).toContain('시작할까요');

    workerRef.decide('task-1', 'approve');
    await done;

    expect(started).toBe(true);
    expect(reports.map((r) => r.type)).toEqual(['waiting', 'started', 'completed']);
  });

  it('시작 전 승인 거부: 아무것도 실행하지 않고 rejected', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let started = false;
    const worker = mkWorker({
      client,
      gate: new ApprovalStartGate(),
      adapters: {
        mock: {
          start: async () => {
            started = true;
          },
        },
      },
      leaseSeconds: 2,
    });

    const done = worker.processOne();
    await until(() => worker.approvals.length > 0);
    worker.decide('task-1', 'deny');
    await done;

    expect(started).toBe(false);
    expect(reports.map((r) => r.type)).toEqual(['waiting', 'rejected']);
  });

  it('면제 라벨은 승인 없이 바로 실행된다', async () => {
    const { client, reports } = mkClient([mkTask()]);
    let workerRef!: Worker;
    workerRef = mkWorker({
      client,
      gate: new ApprovalStartGate({ autoPassLabels: ['demo'] }),
      adapters: {
        mock: {
          start: async (req) => {
            workerRef.handleLocalReport(req.task.id, { type: 'completed' });
          },
        },
      },
    });
    await workerRef.processOne();
    expect(reports.map((r) => r.type)).toEqual(['started', 'completed']);
  });

  it('동시 처리: 한 Task가 승인을 기다려도 다른 Task를 집는다', async () => {
    const { client } = mkClient([mkTask('task-1'), mkTask('task-2')]);
    let workerRef!: Worker;
    workerRef = mkWorker({
      client,
      gate: new ApprovalStartGate(),
      adapters: { mock: { start: async () => {} } },
      leaseSeconds: 2,
    });

    // 첫 루프는 승인 대기에 묶인다
    const first = workerRef.processOne();
    await until(() => workerRef.approvals.length === 1);
    // 두 번째 루프가 그 사이 다음 Task를 집어 자기 승인을 요청한다
    const second = workerRef.processOne();
    await until(() => workerRef.approvals.length === 2);

    expect(workerRef.approvals.map((a) => a.taskId).sort()).toEqual(['task-1', 'task-2']);
    expect(workerRef.current).toHaveLength(2);

    workerRef.decide('task-1', 'deny');
    workerRef.decide('task-2', 'deny');
    await Promise.all([first, second]);
    expect(workerRef.current).toHaveLength(0);
  });

  it('진행 중이 아닌 Task의 보고는 거부된다', () => {
    const worker = mkWorker({});
    expect(worker.handleLocalReport('unknown', { type: 'completed' })).toEqual({ ok: false });
  });

  it('대기 중인 승인이 없으면 decide는 false', () => {
    const worker = mkWorker({});
    expect(worker.decide('task-1', 'approve')).toBe(false);
  });
});
