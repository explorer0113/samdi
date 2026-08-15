import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { WorkerRegistry } from './worker-registry.js';

let db: Db;
let workers: WorkerRegistry;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(() => {
  db = openDb(':memory:');
  workers = new WorkerRegistry(db);
});

describe('claim이 등록을 대신한다', () => {
  it('처음 본 Worker를 기록한다', () => {
    workers.seen('w1', ['demo', 'mail']);
    expect(workers.list()).toMatchObject([{ workerId: 'w1', labels: ['demo', 'mail'] }]);
  });

  it('다시 오면 라벨과 마지막 시각만 갱신하고, 처음 본 시각은 지킨다', () => {
    workers.seen('w1', ['demo'], iso(60_000));
    const first = workers.list()[0]!.firstSeenAt;

    workers.seen('w1', ['demo', 'ops'], iso(0));
    const after = workers.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.labels).toEqual(['demo', 'ops']);
    expect(after[0]!.firstSeenAt).toBe(first);
    expect(after[0]!.lastSeenAt).not.toBe(first);
  });

  it('재시작해도 남는다 — 같은 DB면 목록이 이어진다', () => {
    workers.seen('w1', ['demo']);
    expect(new WorkerRegistry(db).list()).toHaveLength(1);
  });
});

describe('라벨 커버리지', () => {
  it('최근 살아 있던 Worker들의 라벨을 합친다', () => {
    workers.seen('w1', ['demo']);
    workers.seen('w2', ['mail', 'ops']);
    expect(workers.coveredLabels()).toEqual(['demo', 'mail', 'ops']);
  });

  it('오래 조용한 Worker의 라벨은 빠진다 — 이게 "아무도 안 본다"의 근거다', () => {
    workers.seen('gone', ['old-label'], iso(10 * 60_000));
    workers.seen('alive', ['demo'], iso(0));
    expect(workers.coveredLabels(300)).toEqual(['demo']);
  });

  it('일하는 동안 폴링이 멈춰도 창 안이면 살아 있는 것으로 본다', () => {
    // 폴링 주기(2초)보다 훨씬 길게 쉬어도, 기본 창(5분) 안이면 유효하다.
    workers.seen('busy', ['demo'], iso(90_000));
    expect(workers.coveredLabels()).toEqual(['demo']);
  });

  it('Worker가 하나도 없으면 빈 배열 — 모든 라벨이 미커버', () => {
    expect(workers.coveredLabels()).toEqual([]);
  });
});
