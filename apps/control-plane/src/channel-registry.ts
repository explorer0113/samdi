import { randomBytes } from 'node:crypto';
import { channelConfigSchema, interpreterConfigSchema, type ChannelConfig } from '@samdi/config';
import { createInterpreter } from '@samdi/interpreter';
import type { Db } from './db.js';
import type { ChannelRuntime } from './pipeline.js';

/** 채널이 어디서 왔는지. 설정 파일에 적힌 채널은 재시작마다 파일 내용으로 되돌아간다. */
export type ChannelSource = 'config' | 'api';

export interface ChannelRecord {
  id: string;
  label: string;
  source: ChannelSource;
  createdAt: string;
  /** 비활성화된 채널은 목록에 남지만 이벤트를 받지 않는다 */
  disabledAt: string | null;
  interpreter: ChannelConfig['interpreter'];
}

export class ChannelExistsError extends Error {
  constructor(id: string) {
    super(`이미 있는 채널이다: ${id}`);
    this.name = 'ChannelExistsError';
  }
}

export class ChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`없는 채널이다: ${id}`);
    this.name = 'ChannelNotFoundError';
  }
}

/** 설정 파일에서 온 채널은 관리 화면에서 고칠 수 없다 — 파일이 진실이기 때문이다. */
export class ChannelNotEditableError extends Error {
  constructor(id: string) {
    super(`설정 파일에서 온 채널이라 여기서 바꿀 수 없다: ${id} (samdi.server.yaml을 고칠 것)`);
    this.name = 'ChannelNotEditableError';
  }
}

/** 채널 키. 앞의 `ch_`는 로그에서 이게 무슨 키인지 알아보라고 붙인다. */
export function generateChannelKey(): string {
  return `ch_${randomBytes(24).toString('base64url')}`;
}

/**
 * 키를 통째로 다시 보여주지 않는다. 발급 응답에서 한 번 보여주고 그 뒤로는 이 형태만 남는다.
 * 어떤 키였는지 분간할 수 있을 만큼만 남기는 게 목적이다.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

interface ChannelRow {
  id: string;
  label: string;
  key: string;
  interpreter: string;
  source: string;
  created_at: string;
  disabled_at: string | null;
}

/**
 * 채널 목록과 각 채널의 해석기를 소유한다.
 *
 * 예전에는 시작할 때 설정에서 Map을 만들고 끝이었다. 관리 화면에서 채널을 등록할 수 있게
 * 되면서 DB가 진실이 되고, 이 클래스가 DB와 런타임 인스턴스를 함께 들고 있는다 —
 * 해석기는 만드는 비용이 있어서 요청마다 새로 만들 수 없기 때문이다.
 *
 * Pipeline이 기대하는 모양(`get`과 순회)을 그대로 제공하므로 Pipeline은 이걸 Map처럼 쓴다.
 */
export class ChannelRegistry {
  private readonly runtimes = new Map<string, ChannelRuntime>();

  constructor(private readonly db: Db) {}

  /**
   * 설정 파일의 채널을 DB로 반영한다. 파일이 진실이므로 매 시작마다 덮어쓴다.
   * 관리 화면에서 만든 채널(source='api')은 건드리지 않는다.
   */
  syncFromConfig(channels: ChannelConfig[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO channels (id, label, key, interpreter, source, created_at)
       VALUES (?, ?, ?, ?, 'config', ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         key = excluded.key,
         interpreter = excluded.interpreter,
         source = 'config',
         -- 파일에 다시 적었다는 건 되살리겠다는 뜻이다
         disabled_at = NULL`,
    );
    const now = new Date().toISOString();
    for (const channel of channels) {
      upsert.run(
        channel.id,
        channel.label ?? channel.id,
        channel.key,
        JSON.stringify(channel.interpreter),
        now,
      );
    }
  }

  /** 살아 있는 채널로 런타임 맵을 다시 만든다. 시작 시 한 번 부른다. */
  load(): void {
    this.runtimes.clear();
    const rows = this.db
      .prepare('SELECT * FROM channels WHERE disabled_at IS NULL')
      .all() as ChannelRow[];
    for (const row of rows) this.runtimes.set(row.id, this.toRuntime(row));
  }

  private toRuntime(row: ChannelRow): ChannelRuntime {
    // 저장된 JSON도 스키마로 통과시킨다 — 손으로 고친 DB나 구버전 행이 들어와도
    // 기본값으로 메워져서 파이프라인이 깨지지 않는다.
    const interpreter = interpreterConfigSchema.parse(safeJson(row.interpreter));
    const config = channelConfigSchema.parse({
      id: row.id,
      label: row.label,
      key: row.key,
      interpreter,
    });
    return { config, label: row.label, interpreter: createInterpreter(interpreter) };
  }

  /** Pipeline이 쓰는 조회 */
  get(channelId: string): ChannelRuntime | undefined {
    return this.runtimes.get(channelId);
  }

  /** Pipeline의 주기 스캔이 채널을 순회한다 */
  [Symbol.iterator](): IterableIterator<[string, ChannelRuntime]> {
    return this.runtimes.entries();
  }

  /** 웹훅 인증. 키가 맞을 때만 채널을 돌려준다. */
  authenticate(channelId: string, key: string | undefined): ChannelRuntime | null {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || !key) return null;
    return runtime.config.key === key ? runtime : null;
  }

  /** 관리 화면용 목록. 키는 여기서 나가지 않는다. */
  list(): ChannelRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM channels ORDER BY created_at DESC, id')
      .all() as ChannelRow[];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      source: row.source === 'api' ? 'api' : 'config',
      createdAt: row.created_at,
      disabledAt: row.disabled_at,
      interpreter: interpreterConfigSchema.parse(safeJson(row.interpreter)),
    }));
  }

  /** 키를 가려서 보여주기 위한 조회 */
  maskedKey(channelId: string): string | null {
    const row = this.db.prepare('SELECT key FROM channels WHERE id = ?').get(channelId) as
      | { key: string }
      | undefined;
    return row ? maskKey(row.key) : null;
  }

  /**
   * 채널을 등록하고 키를 발급한다. **평문 키는 이 반환값에서만 볼 수 있다** —
   * 이후 조회에서는 가려진 형태만 나간다.
   */
  create(input: {
    id: string;
    label?: string;
    interpreter?: unknown;
  }): { channel: ChannelRecord; key: string } {
    if (this.runtimes.has(input.id)) throw new ChannelExistsError(input.id);

    const interpreter = interpreterConfigSchema.parse(input.interpreter ?? {});
    const key = generateChannelKey();
    const label = input.label ?? input.id;
    const now = new Date().toISOString();

    // 같은 id가 비활성화된 채로 남아 있을 수 있다 (감사 기록 때문에 행을 지우지 않으므로).
    // 그때는 새 키로 되살린다 — id를 영영 못 쓰게 만들 이유가 없다.
    this.db
      .prepare(
        `INSERT INTO channels (id, label, key, interpreter, source, created_at, disabled_at)
         VALUES (?, ?, ?, ?, 'api', ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           key = excluded.key,
           interpreter = excluded.interpreter,
           source = 'api',
           disabled_at = NULL`,
      )
      .run(input.id, label, key, JSON.stringify(interpreter), now);

    this.runtimes.set(
      input.id,
      this.toRuntime({
        id: input.id,
        label,
        key,
        interpreter: JSON.stringify(interpreter),
        source: 'api',
        created_at: now,
        disabled_at: null,
      }),
    );

    return {
      channel: { id: input.id, label, source: 'api', createdAt: now, disabledAt: null, interpreter },
      key,
    };
  }

  /** 키를 새로 발급한다. 예전 키는 그 즉시 통하지 않는다. */
  rotateKey(channelId: string): string {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    if (!row) throw new ChannelNotFoundError(channelId);
    if (row.source !== 'api') throw new ChannelNotEditableError(channelId);

    const key = generateChannelKey();
    this.db.prepare('UPDATE channels SET key = ? WHERE id = ?').run(key, channelId);
    this.runtimes.set(channelId, this.toRuntime({ ...row, key }));
    return key;
  }

  /**
   * 채널을 비활성화한다 — 더 이상 이벤트를 받지 않는다.
   *
   * 행을 실제로 지우지 않는 이유는 Task와 문맥 스레드가 채널을 참조하는 감사 기록이기
   * 때문이다. 지우면 "이 Task가 어느 채널에서 왔는가"를 잃는다.
   * 같은 id로 다시 등록하면 새 키로 되살아난다.
   */
  disable(channelId: string): void {
    const row = this.db.prepare('SELECT source FROM channels WHERE id = ?').get(channelId) as
      | { source: string }
      | undefined;
    if (!row) throw new ChannelNotFoundError(channelId);
    if (row.source !== 'api') throw new ChannelNotEditableError(channelId);

    this.db
      .prepare('UPDATE channels SET disabled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), channelId);
    this.runtimes.delete(channelId);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
