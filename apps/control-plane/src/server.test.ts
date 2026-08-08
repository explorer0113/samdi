import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { buildServer } from './server.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';

let db: Db;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO channels (id, label, key) VALUES (?, ?, ?)').run('demo', 'demo', 'ck');
  const store = new TaskStore(db, new SqlitePayloadStore(db));
  app = buildServer({ db, store, workerKey: 'wk', logger: false });
});

afterEach(async () => {
  await app.close();
});

const workerHeaders = { 'x-worker-key': 'wk' };

async function ingest(payload = '테스트 이벤트'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/channels/demo/events',
    headers: { 'x-channel-key': 'ck' },
    payload: { payload },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { taskId: string }).taskId;
}

async function claim(): Promise<{ task: { id: string } | null; payload: string | null }> {
  const res = await app.inject({
    method: 'POST',
    url: '/tasks/claim',
    headers: workerHeaders,
    payload: { workerId: 'w1', labels: ['demo'] },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('인증', () => {
  it('채널 키가 틀리면 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/channels/demo/events',
      headers: { 'x-channel-key': 'wrong' },
      payload: { payload: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('없는 채널이면 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/channels/nope/events',
      headers: { 'x-channel-key': 'ck' },
      payload: { payload: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('worker 키가 없으면 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/claim',
      payload: { workerId: 'w1', labels: ['demo'] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('이벤트 → claim → 보고 흐름', () => {
  it('수신한 이벤트를 claim하면 본문이 함께 온다 (leaseSeconds 기본값 적용)', async () => {
    const taskId = await ingest('메일 회신해줘');
    const { task, payload } = await claim();
    expect(task?.id).toBe(taskId);
    expect(payload).toBe('메일 회신해줘');
    // 두 번째 claim은 빈손
    const second = await claim();
    expect(second.task).toBeNull();
  });

  it('started → completed 보고가 상태에 반영된다', async () => {
    const taskId = await ingest();
    await claim();
    for (const report of [{ type: 'started' }, { type: 'completed', summary: 'ok' }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/report`,
        headers: workerHeaders,
        payload: report,
      });
      expect(res.statusCode).toBe(200);
    }
    const list = await app.inject({ method: 'GET', url: '/tasks', headers: workerHeaders });
    const { tasks } = list.json() as { tasks: Array<{ status: string; preview: string }> };
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.preview).toBe('테스트 이벤트');
  });

  it('상세 조회는 본문과 감사 이벤트를 담는다', async () => {
    const taskId = await ingest();
    await claim();
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${taskId}`,
      headers: workerHeaders,
    });
    const detail = res.json() as { payload: string; events: Array<{ type: string }> };
    expect(detail.payload).toBe('테스트 이벤트');
    expect(detail.events.map((e) => e.type)).toEqual(['created', 'claimed']);
  });
});

describe('에러 매핑', () => {
  it('스키마 위반 본문은 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/channels/demo/events',
      headers: { 'x-channel-key': 'ck' },
      payload: { payload: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('불법 전이 보고는 409', async () => {
    const taskId = await ingest();
    // claim 없이 completed 보고 → pending → completed는 불법
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/report`,
      headers: workerHeaders,
      payload: { type: 'completed' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('없는 Task 보고는 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/nope/report',
      headers: workerHeaders,
      payload: { type: 'started' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('주입 시점에 에이전트를 지정하면 생성부터 박혀 있다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/channels/demo/events',
      headers: { 'x-channel-key': 'ck' },
      payload: { payload: '터미널로 처리해줘', agent: 'claude-code-terminal' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = await claim();
    expect((task as { agent?: string } | null)?.agent).toBe('claude-code-terminal');
  });

  it('pending Task에 에이전트 지정 200, claim 후에는 409', async () => {
    const taskId = await ingest();
    const ok = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/agent`,
      headers: workerHeaders,
      payload: { agent: 'claude-code' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { task: { agent: string } }).task.agent).toBe('claude-code');

    await claim();
    const conflict = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/agent`,
      headers: workerHeaders,
      payload: { agent: 'mock' },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('stalled가 아닌 Task의 retry는 409', async () => {
    const taskId = await ingest();
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/retry`,
      headers: workerHeaders,
      payload: { action: 'retry' },
    });
    expect(res.statusCode).toBe(409);
  });
});
