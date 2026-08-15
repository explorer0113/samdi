import type { Db } from './db.js';

export interface WorkerRecord {
  workerId: string;
  /** 이 Worker가 claim하겠다고 밝힌 라벨들 */
  labels: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Worker 목록. 별도 등록 절차 없이 **claim 요청에서 받아 적는다.**
 *
 * claim은 이미 `{workerId, labels}`를 보내고 있고 Worker는 쉬는 동안에도 주기적으로
 * 폴링하므로, 그걸 기록하는 것만으로 "지금 어떤 Worker가 어떤 라벨을 보고 있는가"를
 * 알 수 있다. 등록 API를 따로 만들면 Worker가 그걸 부르는 걸 잊었을 때 목록이 거짓말을
 * 하는데, 이 방식은 실제로 일을 가져가려는 Worker만 나타나므로 그런 어긋남이 없다.
 *
 * 한계: 일을 처리하는 동안에는 폴링이 멈추므로 `lastSeenAt`이 잠시 멀어진다.
 * "살아 있는가"의 근거로 쓸 때는 폴링 주기보다 넉넉한 창을 잡아야 한다.
 */
export class WorkerRegistry {
  constructor(private readonly db: Db) {}

  /** claim할 때마다 부른다. 처음 보는 Worker면 새로 넣고, 아니면 라벨과 시각을 갱신한다. */
  seen(workerId: string, labels: string[], now = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO workers (id, labels, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           labels = excluded.labels,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(workerId, JSON.stringify(labels), now, now);
  }

  list(): WorkerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workers ORDER BY last_seen_at DESC')
      .all() as { id: string; labels: string; first_seen_at: string; last_seen_at: string }[];
    return rows.map((row) => ({
      workerId: row.id,
      labels: safeLabels(row.labels),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /**
   * 최근 살아 있던 Worker들이 보는 라벨의 합집합.
   * 이 집합에 없는 라벨로 Task를 만들면 아무도 가져가지 않는다.
   */
  coveredLabels(withinSeconds = 300, now = Date.now()): string[] {
    const cutoff = now - withinSeconds * 1000;
    const labels = new Set<string>();
    for (const worker of this.list()) {
      if (Date.parse(worker.lastSeenAt) >= cutoff) {
        for (const label of worker.labels) labels.add(label);
      }
    }
    return [...labels].sort();
  }
}

function safeLabels(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
