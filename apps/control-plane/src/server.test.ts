import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpreterConfigSchema } from '@samdi/config';
import { ChannelRegistry } from './channel-registry.js';
import { openDb, type Db } from './db.js';
import { Pipeline } from './pipeline.js';
import { buildServer } from './server.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';
import { ThreadStore } from './thread-store.js';
import { WorkerRegistry } from './worker-registry.js';

let db: Db;
let app: ReturnType<typeof buildServer>;
let channels: ChannelRegistry;

const noopLog = { info: () => {}, error: () => {} };

beforeEach(() => {
  db = openDb(':memory:');
  const store = new TaskStore(db, new SqlitePayloadStore(db));
  const threads = new ThreadStore(db);
  channels = new ChannelRegistry(db);
  channels.syncFromConfig([
    { id: 'demo', label: 'demo', key: 'ck', interpreter: interpreterConfigSchema.parse({}) },
  ]);
  channels.load();
  const pipeline = new Pipeline(channels, threads, store, noopLog);
  app = buildServer({
    db,
    store,
    pipeline,
    threads,
    channels,
    workers: new WorkerRegistry(db),
    workerKey: 'wk',
    adminKey: 'ak',
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
});

const workerHeaders = { 'x-worker-key': 'wk' };
const adminHeaders = { 'x-admin-key': 'ak' };

async function ingest(payload = '테스트 이벤트'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/channels/demo/events',
    headers: { 'x-channel-key': 'ck' },
    payload: { payload },
  });
  expect(res.statusCode).toBe(200);
  const { taskId } = res.json() as { taskId: string | null };
  expect(taskId).not.toBeNull();
  return taskId!;
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

  it('없는 채널이든 키가 틀리든 똑같은 401을 준다 — 채널 id를 훑지 못하게', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/channels/nope/events',
      headers: { 'x-channel-key': 'ck' },
      payload: { payload: 'x' },
    });
    const wrongKey = await app.inject({
      method: 'POST',
      url: '/channels/demo/events',
      headers: { 'x-channel-key': '틀린키' },
      payload: { payload: 'x' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrongKey.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrongKey.json());
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
    // 기본 목록(폴링 경로)에서는 종결된 Task가 빠진다
    const active = await app.inject({ method: 'GET', url: '/tasks', headers: workerHeaders });
    expect((active.json() as { tasks: unknown[] }).tasks).toHaveLength(0);

    // 종결분은 view=all 로 조회한다
    const list = await app.inject({
      method: 'GET',
      url: '/tasks?view=all',
      headers: workerHeaders,
    });
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
      payload: { payload: '터미널로 처리해줘', agent: 'claude-code' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = await claim();
    expect((task as { agent?: string } | null)?.agent).toBe('claude-code');
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

describe('키마다 권한이 다르다', () => {
  it('Worker 키로는 관리 경로에 닿지 않는다', async () => {
    for (const url of ['/admin/overview', '/admin/channels']) {
      const res = await app.inject({ method: 'GET', url, headers: workerHeaders });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('관리 키로는 claim할 수 없다 — 일을 가져가는 건 Worker의 몫이다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/claim',
      headers: adminHeaders,
      payload: { workerId: 'w1', labels: ['demo'] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Task 조회는 두 키 모두 통한다', async () => {
    await ingest();
    for (const headers of [workerHeaders, adminHeaders]) {
      const res = await app.inject({ method: 'GET', url: '/tasks', headers });
      expect(res.statusCode).toBe(200);
    }
  });

  it('키가 없으면 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/overview' })).statusCode).toBe(401);
  });
});

describe('채널 등록과 키 발급', () => {
  function createChannel(body: { id: string; label?: string; interpreter?: unknown }) {
    return app.inject({
      method: 'POST',
      url: '/admin/channels',
      headers: adminHeaders,
      payload: body,
    });
  }

  it('등록하면 키를 발급하고, 그 키로 바로 이벤트가 들어간다', async () => {
    const res = await createChannel({ id: 'mail', label: 'mail' });
    expect(res.statusCode).toBe(201);
    const { key, channel } = res.json() as { key: string; channel: { id: string; source: string } };
    expect(channel.source).toBe('api');
    expect(key).toMatch(/^ch_/);

    // 재시작 없이 바로 살아 있어야 한다 — 런타임 맵에도 들어갔다는 뜻이다.
    const ingested = await app.inject({
      method: 'POST',
      url: '/channels/mail/events',
      headers: { 'x-channel-key': key },
      payload: { payload: '새 채널로 들어온 이벤트' },
    });
    expect(ingested.statusCode).toBe(200);
    expect((ingested.json() as { taskId: string | null }).taskId).not.toBeNull();
  });

  it('평문 키는 발급 응답에서만 나온다 — 목록에서는 가려진다', async () => {
    const { key } = (await createChannel({ id: 'mail' })).json() as { key: string };
    const list = await app.inject({ method: 'GET', url: '/admin/channels', headers: adminHeaders });
    const body = list.payload;
    expect(body).not.toContain(key);
    const { channels: rows } = list.json() as { channels: { id: string; maskedKey: string }[] };
    expect(rows.find((c) => c.id === 'mail')?.maskedKey).toMatch(/…/);
  });

  it('키를 재발급하면 예전 키는 즉시 막힌다', async () => {
    const { key: oldKey } = (await createChannel({ id: 'mail' })).json() as { key: string };
    const rotated = await app.inject({
      method: 'POST',
      url: '/admin/channels/mail/key',
      headers: adminHeaders,
    });
    const { key: newKey } = rotated.json() as { key: string };
    expect(newKey).not.toBe(oldKey);

    const withOld = await app.inject({
      method: 'POST',
      url: '/channels/mail/events',
      headers: { 'x-channel-key': oldKey },
      payload: { payload: '예전 키' },
    });
    expect(withOld.statusCode).toBe(401);
  });

  it('설정 파일에서 온 채널은 관리 화면에서 못 바꾼다', async () => {
    const rotate = await app.inject({
      method: 'POST',
      url: '/admin/channels/demo/key',
      headers: adminHeaders,
    });
    expect(rotate.statusCode).toBe(403);
    const removed = await app.inject({
      method: 'DELETE',
      url: '/admin/channels/demo',
      headers: adminHeaders,
    });
    expect(removed.statusCode).toBe(403);
  });

  it('같은 id로 두 번 등록하면 409', async () => {
    expect((await createChannel({ id: 'mail' })).statusCode).toBe(201);
    expect((await createChannel({ id: 'mail' })).statusCode).toBe(409);
  });

  it('URL에 못 쓰는 id는 거부한다', async () => {
    expect((await createChannel({ id: 'My Mail!' })).statusCode).toBe(400);
  });

});

describe('관리 현황', () => {
  it('상태별 Task 수와 붙어 있는 Worker를 센다', async () => {
    await ingest();
    await ingest();
    await claim();

    const res = await app.inject({ method: 'GET', url: '/admin/overview', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tasks: Record<string, number>;
      workers: { workerId: string; labels: string[]; inFlight: number }[];
      coveredLabels: string[];
      channels: number;
    };
    expect(body.tasks.pending).toBe(1);
    expect(body.tasks.claimed).toBe(1);
    expect(body.workers).toMatchObject([{ workerId: 'w1', labels: ['demo'], inFlight: 1 }]);
    expect(body.channels).toBe(1);
  });

  it('claim만 해도 Worker가 등록된다 — 일이 없어도 목록에 남는다', async () => {
    // 빈손 claim (Task 없음)
    await claim();

    const body = (
      await app.inject({ method: 'GET', url: '/admin/overview', headers: adminHeaders })
    ).json() as { workers: { workerId: string; inFlight: number }[]; coveredLabels: string[] };

    expect(body.workers).toMatchObject([{ workerId: 'w1', inFlight: 0 }]);
    expect(body.coveredLabels).toEqual(['demo']);
  });

  it('아무도 안 보는 라벨은 coveredLabels에 없다 — 화면이 경고할 근거', async () => {
    await claim(); // w1이 demo만 본다

    await app.inject({
      method: 'POST',
      url: '/admin/channels',
      headers: adminHeaders,
      payload: { id: 'orphan-ch' }, // label 생략 → id가 라벨이 된다
    });
    await app.inject({
      method: 'POST',
      url: '/admin/channels/orphan-ch/events',
      headers: adminHeaders,
      payload: { payload: '아무도 안 가져갈 이벤트' },
    });

    const body = (
      await app.inject({ method: 'GET', url: '/admin/overview', headers: adminHeaders })
    ).json() as { coveredLabels: string[]; tasks: Record<string, number> };

    expect(body.coveredLabels).not.toContain('orphan-ch');
    expect(body.tasks.pending).toBe(1); // 만들어졌지만 아무도 안 가져간다
  });

  it('관리 화면에서는 채널 키 없이 이벤트를 넣어볼 수 있다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/channels/demo/events',
      headers: adminHeaders,
      payload: { payload: '관리 화면에서 넣은 이벤트' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { taskId: string | null }).taskId).not.toBeNull();
  });
});
