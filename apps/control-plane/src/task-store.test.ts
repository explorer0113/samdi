import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';

let db: Db;
let store: TaskStore;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO channels (id, label, key) VALUES (?, ?, ?)').run('demo', 'demo', 'k');
  store = new TaskStore(db, new SqlitePayloadStore(db));
});

describe('TaskStore', () => {
  it('이벤트 수신 → pending Task 생성, 본문은 분리 저장', async () => {
    const task = await store.createTask('demo', 'demo', '메일 회신해줘');
    expect(task.status).toBe('pending');
    const detail = await store.getTaskDetail(task.id);
    expect(detail.payload).toBe('메일 회신해줘');
    expect(detail.events.map((e) => e.type)).toEqual(['created']);
  });

  it('claim은 라벨이 맞는 가장 오래된 pending을 원자적으로 가져간다', async () => {
    const first = await store.createTask('demo', 'demo', 'first');
    await store.createTask('demo', 'demo', 'second');
    const claimed = store.claimNext('w1', ['demo'], 600);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.workerId).toBe('w1');
    expect(claimed?.leaseExpiresAt).not.toBeNull();
    // 같은 Task는 다시 claim되지 않는다
    const again = store.claimNext('w2', ['demo'], 600);
    expect(again?.payloadRef).not.toBe(claimed?.payloadRef);
  });

  it('라벨이 안 맞으면 claim하지 못한다', async () => {
    await store.createTask('demo', 'demo', 'x');
    expect(store.claimNext('w1', ['other-label'], 600)).toBeNull();
  });

  it('정상 경로: started → completed', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    store.claimNext('w1', ['demo'], 600);
    expect(store.applyReport(task.id, { type: 'started' }).status).toBe('running');
    expect(store.applyReport(task.id, { type: 'completed', summary: 'ok' }).status).toBe(
      'completed',
    );
    const detail = await store.getTaskDetail(task.id);
    expect(detail.events.map((e) => e.type)).toEqual([
      'created',
      'claimed',
      'report:started',
      'report:completed',
    ]);
  });

  it('목록은 기본적으로 진행 중인 것만, 최신순으로 준다', async () => {
    const done = await store.createTask('demo', 'demo', '끝난 것');
    store.claimNext('w1', ['demo'], 600);
    store.applyReport(done.id, { type: 'started' });
    store.applyReport(done.id, { type: 'completed' });
    const live = await store.createTask('demo', 'demo', '진행 중');

    // 기본(active): 종결된 것은 빠진다
    expect(store.listTasks().map((t) => t.id)).toEqual([live.id]);
    // view: 'all': 전부, 최신 생성순
    expect(store.listTasks({ view: 'all' }).map((t) => t.id)).toEqual([live.id, done.id]);
    // status 명시: 그 상태만
    expect(store.listTasks({ status: 'completed' }).map((t) => t.id)).toEqual([done.id]);
  });

  it('목록에 limit이 걸린다 (기본 50, 상한 200)', async () => {
    for (let i = 0; i < 5; i++) await store.createTask('demo', 'demo', `t${i}`);
    expect(store.listTasks({ limit: 2 })).toHaveLength(2);
    expect(store.listTasks({ limit: 999 })).toHaveLength(5); // 상한을 넘겨도 안전
    expect(store.listTasks()).toHaveLength(5);
  });

  it('claim은 lease 만료 스캔을 돌리지 않는다 (주기 스캔의 몫)', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    store.claimNext('w1', ['demo'], 600);
    db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      task.id,
    );

    // 다른 Worker가 claim을 시도해도 만료 처리가 일어나지 않는다
    store.claimNext('w2', ['demo'], 600);
    expect(store.listTasks({ view: 'all' })[0]?.status).toBe('claimed');

    // 주기 스캔이 돌아야 stalled가 된다
    expect(store.sweepExpiredLeases()).toBe(1);
    expect(store.listTasks({ view: 'all' })[0]?.status).toBe('stalled');
  });

  it('Start Gate 기각은 rejected로 마감된다', async () => {
    const b = await store.createTask('demo', 'demo', 'b');
    store.claimNext('w1', ['demo'], 600);
    expect(store.applyReport(b.id, { type: 'rejected', reason: '정책 위반' }).status).toBe(
      'rejected',
    );
  });

  it('승인 대기 왕복: waiting → resumed → completed', async () => {
    const task = await store.createTask('demo', 'demo', '계정 삭제 승인 요청');
    store.claimNext('w1', ['demo'], 600);
    store.applyReport(task.id, { type: 'started' });
    expect(store.applyReport(task.id, { type: 'waiting', question: '삭제할까요?' }).status).toBe(
      'waiting',
    );
    expect(store.applyReport(task.id, { type: 'resumed' }).status).toBe('running');
    expect(store.applyReport(task.id, { type: 'completed' }).status).toBe('completed');
  });

  it('승인 거부: waiting → failed', async () => {
    const task = await store.createTask('demo', 'demo', '계정 삭제 승인 요청');
    store.claimNext('w1', ['demo'], 600);
    store.applyReport(task.id, { type: 'started' });
    store.applyReport(task.id, { type: 'waiting', question: '삭제할까요?' });
    expect(store.applyReport(task.id, { type: 'failed', reason: '사용자 거부' }).status).toBe(
      'failed',
    );
  });

  it('pending 동안 에이전트를 지정할 수 있다', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    expect(task.agent).toBeNull();
    const updated = store.setAgent(task.id, 'claude-code');
    expect(updated.agent).toBe('claude-code');
    const claimed = store.claimNext('w1', ['demo'], 600);
    expect(claimed?.agent).toBe('claude-code');
    const detail = await store.getTaskDetail(task.id);
    expect(detail.events.map((e) => e.type)).toContain('agent_assigned');
  });

  it('claim된 뒤에는 에이전트를 바꿀 수 없다', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    store.claimNext('w1', ['demo'], 600);
    expect(() => store.setAgent(task.id, 'mock')).toThrowError(/task not pending/);
  });

  it('불법 전이는 거부된다', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    expect(() => store.applyReport(task.id, { type: 'completed' })).toThrowError(
      /invalid task transition/,
    );
  });

  it('lease 만료 → stalled → 수동 재시도만 가능', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    store.claimNext('w1', ['demo'], 600);
    store.applyReport(task.id, { type: 'started' });
    // lease를 과거로 조작해 만료를 흉내낸다
    db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      task.id,
    );
    expect(store.sweepExpiredLeases()).toBe(1);

    // stalled는 claim 대상이 아니다 (자동 재배포 금지)
    expect(store.claimNext('w2', ['demo'], 600)).toBeNull();

    // 사용자 재시도 승인 → pending으로 복귀, worker/lease 초기화
    const retried = store.resolveStalled(task.id, 'retry');
    expect(retried.status).toBe('pending');
    expect(retried.workerId).toBeNull();
    expect(retried.leaseExpiresAt).toBeNull();
    expect(store.claimNext('w2', ['demo'], 600)?.id).toBe(task.id);
  });

  it('stalled 포기 → failed', async () => {
    const task = await store.createTask('demo', 'demo', 'x');
    store.claimNext('w1', ['demo'], 600);
    db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      task.id,
    );
    store.sweepExpiredLeases();
    expect(store.resolveStalled(task.id, 'abandon').status).toBe('failed');
  });
});
