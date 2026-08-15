import { randomUUID } from 'node:crypto';
import type { ContextThread, ThreadEvent, ThreadStatus } from '@samdi/protocol';
import type { Db } from './db.js';

const now = () => new Date().toISOString();

interface ThreadRow {
  id: string;
  channel_id: string;
  context_key: string;
  status: string;
  agent: string | null;
  event_seq: number;
  interpreted_seq: number;
  last_event_at: string;
  last_interpreted_at: string | null;
  created_at: string;
  updated_at: string;
}

function toThread(row: ThreadRow): ContextThread {
  return {
    id: row.id,
    channelId: row.channel_id,
    contextKey: row.context_key,
    status: row.status as ThreadStatus,
    lastEventAt: row.last_event_at,
    agent: row.agent,
    eventSeq: row.event_seq,
    interpretedSeq: row.interpreted_seq,
    lastInterpretedAt: row.last_interpreted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 문맥 스레드 저장소.
 * 해석기가 유지하는 상태이며, Task 상태와는 별개의 생명주기를 갖는다.
 */
export class ThreadStore {
  constructor(private readonly db: Db) {}

  /** 열린 스레드에 이벤트를 붙인다. 없으면 새로 연다. */
  append(
    channelId: string,
    contextKey: string,
    payload: string,
    agent?: string,
  ): ContextThread {
    const t = now();
    const tx = this.db.transaction((): string => {
      const open = this.db
        .prepare(
          `SELECT id FROM context_threads
           WHERE channel_id = ? AND context_key = ? AND status = 'open'`,
        )
        .get(channelId, contextKey) as { id: string } | undefined;

      const threadId = open?.id ?? randomUUID();
      if (!open) {
        this.db
          .prepare(
            `INSERT INTO context_threads
               (id, channel_id, context_key, status, agent, event_seq, interpreted_seq,
                last_event_at, last_interpreted_at, created_at, updated_at)
             VALUES (?, ?, ?, 'open', ?, 1, 0, ?, NULL, ?, ?)`,
          )
          .run(threadId, channelId, contextKey, agent ?? null, t, t, t);
      } else {
        this.db
          .prepare(
            `UPDATE context_threads
             SET event_seq = event_seq + 1, last_event_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(t, t, threadId);
      }
      this.db
        .prepare('INSERT INTO thread_events (id, thread_id, payload, received_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), threadId, payload, t);
      return threadId;
    });
    return this.get(tx())!;
  }

  get(threadId: string): ContextThread | null {
    const row = this.db.prepare('SELECT * FROM context_threads WHERE id = ?').get(threadId) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : null;
  }

  events(threadId: string): ThreadEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM thread_events WHERE thread_id = ? ORDER BY received_at')
      .all(threadId) as Array<{
      id: string;
      thread_id: string;
      payload: string;
      received_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      payload: r.payload,
      receivedAt: r.received_at,
    }));
  }

  /**
   * 해석기를 돌릴 때가 된 열린 스레드들.
   * 조건: 마지막 이벤트 이후 debounce가 지났고, 아직 해석하지 않은 이벤트가 있다.
   * DB에서 다시 확인하므로 타이머와 주기 스캔 어느 쪽이 불러도 중복 판정되지 않는다.
   */
  dueForInterpretation(channelId: string, debounceMs: number): ContextThread[] {
    const cutoff = new Date(Date.now() - debounceMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM context_threads
         WHERE channel_id = ? AND status = 'open' AND last_event_at <= ?
           AND interpreted_seq < event_seq
         ORDER BY last_event_at`,
      )
      .all(channelId, cutoff) as ThreadRow[];
    return rows.map(toThread);
  }

  /**
   * 해석을 마쳤다고 기록한다.
   * 해석을 시작할 때 읽은 시퀀스를 넘겨야 한다 — 해석 도중 새 이벤트가 붙었다면
   * event_seq가 더 커져 있으므로 그 스레드는 계속 해석 대상으로 남는다.
   */
  markInterpreted(threadId: string, interpretedSeq: number): void {
    const t = now();
    this.db
      .prepare(
        `UPDATE context_threads
         SET interpreted_seq = ?, last_interpreted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(interpretedSeq, t, t, threadId);
  }

  close(threadId: string, status: Exclude<ThreadStatus, 'open'>): void {
    const t = now();
    this.db
      .prepare('UPDATE context_threads SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, t, threadId);
  }

  /** 채널 TTL 동안 새 이벤트가 없는 열린 스레드를 닫는다. */
  expireStale(channelId: string, ttlSeconds: number): string[] {
    const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM context_threads
         WHERE channel_id = ? AND status = 'open' AND last_event_at < ?`,
      )
      .all(channelId, cutoff) as Array<{ id: string }>;
    for (const row of rows) this.close(row.id, 'expired');
    return rows.map((r) => r.id);
  }

  listByChannel(channelId: string): ContextThread[] {
    const rows = this.db
      .prepare('SELECT * FROM context_threads WHERE channel_id = ? ORDER BY created_at')
      .all(channelId) as ThreadRow[];
    return rows.map(toThread);
  }
}
