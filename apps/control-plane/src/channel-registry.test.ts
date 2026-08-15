import { interpreterConfigSchema, type ChannelConfig } from '@samdi/config';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChannelExistsError,
  ChannelInUseError,
  ChannelNotEditableError,
  ChannelNotFoundError,
  ChannelRegistry,
  maskKey,
} from './channel-registry.js';
import { openDb, type Db } from './db.js';

let db: Db;

const channel = (id: string, key: string, mode: 'passthrough' | 'claude' = 'passthrough'): ChannelConfig => ({
  id,
  label: id,
  key,
  interpreter: interpreterConfigSchema.parse({ mode }),
});

/** 프로세스를 다시 띄우는 것과 같다 — 같은 DB에 새 레지스트리를 얹는다. */
function restart(configChannels: ChannelConfig[] = []): ChannelRegistry {
  const registry = new ChannelRegistry(db);
  registry.syncFromConfig(configChannels);
  registry.load();
  return registry;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('설정 파일 채널', () => {
  it('시작할 때마다 파일 내용으로 덮어쓴다 — 파일이 진실이다', () => {
    restart([channel('demo', 'old-key')]);
    const after = restart([channel('demo', 'new-key')]);
    expect(after.authenticate('demo', 'new-key')).not.toBeNull();
    expect(after.authenticate('demo', 'old-key')).toBeNull();
  });

  it('해석기 모드도 파일에서 따라온다', () => {
    const registry = restart([channel('mail', 'k', 'claude')]);
    expect(registry.get('mail')?.config.interpreter.mode).toBe('claude');
  });
});

describe('관리 화면에서 만든 채널', () => {
  it('재시작해도 살아 있고, 설정 동기화가 지우지 않는다', () => {
    const first = restart([channel('demo', 'ck')]);
    const { key } = first.create({ id: 'mail', label: 'mail' });

    const after = restart([channel('demo', 'ck')]);
    expect(after.authenticate('mail', key)).not.toBeNull();
    expect(after.list().map((c) => c.id).sort()).toEqual(['demo', 'mail']);
  });

  it('해석기 설정이 재시작 후에도 유지된다', () => {
    restart().create({ id: 'mail', interpreter: { mode: 'claude', debounceMs: 5000 } });
    const after = restart();
    expect(after.get('mail')?.config.interpreter.mode).toBe('claude');
    expect(after.get('mail')?.config.interpreter.debounceMs).toBe(5000);
  });

  it('label을 생략하면 id를 쓴다 — 라우팅 기준이 비지 않게', () => {
    const registry = restart();
    expect(registry.create({ id: 'mail' }).channel.label).toBe('mail');
  });

  it('키를 재발급하면 예전 키는 통하지 않는다', () => {
    const registry = restart();
    const { key: old } = registry.create({ id: 'mail' });
    const fresh = registry.rotateKey('mail');
    expect(registry.authenticate('mail', old)).toBeNull();
    expect(registry.authenticate('mail', fresh)).not.toBeNull();
  });

  it('비활성화해도 이미 만들어진 Task는 남는다 — 감사 기록이기 때문', () => {
    const registry = restart();
    const { key } = registry.create({ id: 'mail' });
    db.prepare("INSERT INTO payloads (ref, body, created_at) VALUES ('p1', 'x', '')").run();
    db.prepare(
      `INSERT INTO tasks (id, channel_id, label, payload_ref, status, created_at, updated_at)
       VALUES ('t1', 'mail', 'mail', 'p1', 'completed', '', '')`,
    ).run();

    registry.disable('mail');
    expect(registry.authenticate('mail', key)).toBeNull(); // 더 이상 이벤트를 안 받는다
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    // 목록에는 남아서 "왜 안 도는지" 알 수 있어야 한다
    expect(registry.list().find((c) => c.id === 'mail')?.disabledAt).toBeTruthy();
  });

  it('비활성화 상태는 재시작해도 유지된다', () => {
    const first = restart();
    const { key } = first.create({ id: 'mail' });
    first.disable('mail');
    expect(restart().authenticate('mail', key)).toBeNull();
  });

  it('같은 id로 다시 등록하면 새 키로 되살아난다', () => {
    const registry = restart();
    const { key: old } = registry.create({ id: 'mail' });
    registry.disable('mail');

    const { key: revived } = registry.create({ id: 'mail' });
    expect(revived).not.toBe(old);
    expect(registry.authenticate('mail', revived)).not.toBeNull();
    expect(registry.authenticate('mail', old)).toBeNull();
  });
});

describe('거부하는 것들', () => {
  it('같은 id로 두 번 만들 수 없다', () => {
    const registry = restart();
    registry.create({ id: 'mail' });
    expect(() => registry.create({ id: 'mail' })).toThrow(ChannelExistsError);
  });

  it('설정 파일에서 온 채널은 키 재발급도 비활성화도 안 된다 — 파일을 고쳐야 한다', () => {
    const registry = restart([channel('demo', 'ck')]);
    expect(() => registry.rotateKey('demo')).toThrow(ChannelNotEditableError);
    expect(() => registry.disable('demo')).toThrow(ChannelNotEditableError);
  });

  it('없는 채널은 NotFound', () => {
    const registry = restart();
    expect(() => registry.rotateKey('nope')).toThrow(ChannelNotFoundError);
    expect(() => registry.disable('nope')).toThrow(ChannelNotFoundError);
  });

  it('키 없이 온 요청은 인증되지 않는다', () => {
    const registry = restart([channel('demo', 'ck')]);
    expect(registry.authenticate('demo', undefined)).toBeNull();
    expect(registry.authenticate('demo', '')).toBeNull();
  });
});

describe('키 마스킹', () => {
  it('앞뒤 일부만 남긴다 — 어떤 키인지 분간할 만큼만', () => {
    const masked = maskKey('ch_abcdefghijklmnop');
    expect(masked).toBe('ch_ab…mnop');
    expect(masked).not.toContain('cdefghijkl');
  });

  it('짧은 키는 통째로 가린다', () => {
    expect(maskKey('short')).toBe('•••••');
  });
});


describe('삭제', () => {
  /** 이 채널이 Task 하나와 문맥 스레드 하나를 남겼다고 치자 */
  function leaveRecords(channelId: string) {
    db.prepare("INSERT INTO payloads (ref, body, created_at) VALUES ('p1', '본문', '')").run();
    db.prepare(
      `INSERT INTO tasks (id, channel_id, label, payload_ref, status, created_at, updated_at)
       VALUES ('t1', ?, ?, 'p1', 'completed', '', '')`,
    ).run(channelId, channelId);
    db.prepare(
      "INSERT INTO task_events (id, task_id, at, type, data) VALUES ('e1', 't1', '', 'created', '{}')",
    ).run();
    db.prepare(
      `INSERT INTO context_threads (id, channel_id, context_key, status, last_event_at, created_at, updated_at)
       VALUES ('th1', ?, 'k', 'dispatched', '', '', '')`,
    ).run(channelId);
    db.prepare(
      "INSERT INTO thread_events (id, thread_id, payload, received_at) VALUES ('te1', 'th1', 'x', '')",
    ).run();
  }

  it('걸린 기록이 없으면 흔적 없이 지운다', () => {
    const registry = restart();
    registry.create({ id: 'oops' });
    registry.remove('oops');

    expect(registry.get('oops')).toBeUndefined();
    expect(registry.list().map((c) => c.id)).not.toContain('oops');
    // 비활성화와 달리 행 자체가 없다
    expect(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE id = 'oops'").get()).toEqual({ n: 0 });
  });

  it('걸린 기록이 있으면 거부하고 몇 건인지 알려준다', () => {
    const registry = restart();
    registry.create({ id: 'busy' });
    leaveRecords('busy');

    try {
      registry.remove('busy');
      throw new Error('던졌어야 한다');
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelInUseError);
      expect((err as ChannelInUseError).refs).toEqual({ tasks: 1, threads: 1 });
    }
    // 거부했으면 아무것도 건드리지 않았어야 한다
    expect(registry.get('busy')).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  it('purge면 걸린 기록까지 함께 지운다 — 본문과 감사 이벤트도', () => {
    const registry = restart();
    registry.create({ id: 'busy' });
    leaveRecords('busy');

    expect(registry.remove('busy', { purge: true })).toEqual({ tasks: 1, threads: 1 });

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('channels')).toBe(0);
    expect(count('tasks')).toBe(0);
    expect(count('task_events')).toBe(0);
    expect(count('payloads')).toBe(0);
    expect(count('context_threads')).toBe(0);
    expect(count('thread_events')).toBe(0);
  });

  it('다른 채널의 기록은 건드리지 않는다', () => {
    const registry = restart();
    registry.create({ id: 'busy' });
    registry.create({ id: 'other' });
    leaveRecords('busy');
    db.prepare("INSERT INTO payloads (ref, body, created_at) VALUES ('p2', '남을 본문', '')").run();
    db.prepare(
      `INSERT INTO tasks (id, channel_id, label, payload_ref, status, created_at, updated_at)
       VALUES ('t2', 'other', 'other', 'p2', 'completed', '', '')`,
    ).run();

    registry.remove('busy', { purge: true });

    expect(db.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 't2' }]);
    expect(db.prepare('SELECT ref FROM payloads').all()).toEqual([{ ref: 'p2' }]);
    expect(registry.get('other')).toBeDefined();
  });

  it('설정 파일에서 온 채널은 못 지운다', () => {
    const registry = restart([channel('demo', 'ck')]);
    expect(() => registry.remove('demo')).toThrow(ChannelNotEditableError);
    expect(() => registry.remove('demo', { purge: true })).toThrow(ChannelNotEditableError);
  });

  it('없는 채널은 NotFound', () => {
    expect(() => restart().remove('nope')).toThrow(ChannelNotFoundError);
  });

  it('지운 id는 다시 쓸 수 있다', () => {
    const registry = restart();
    const { key: old } = registry.create({ id: 'reuse' });
    registry.remove('reuse');

    const { key: fresh } = registry.create({ id: 'reuse' });
    expect(fresh).not.toBe(old);
    expect(registry.authenticate('reuse', fresh)).not.toBeNull();
  });
});
