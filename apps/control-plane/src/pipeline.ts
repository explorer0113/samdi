import { randomUUID } from 'node:crypto';
import type { ChannelConfig } from '@samdi/config';
import type { Interpreter } from '@samdi/interpreter';
import type { ContextThread } from '@samdi/protocol';
import type { TaskStore } from './task-store.js';
import type { ThreadStore } from './thread-store.js';

export interface ChannelRuntime {
  config: ChannelConfig;
  label: string;
  interpreter: Interpreter;
}

/**
 * Pipeline이 채널에 대해 필요로 하는 전부 — 하나 찾기와 전체 순회.
 * `Map<string, ChannelRuntime>`이 그대로 만족하므로 테스트는 Map을 넘기고,
 * 실제 서버는 DB를 소유한 ChannelRegistry를 넘긴다.
 */
export interface ChannelLookup extends Iterable<[string, ChannelRuntime]> {
  get(channelId: string): ChannelRuntime | undefined;
}

export interface PipelineLog {
  info(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface IngestResult {
  taskId: string | null;
  threadId: string | null;
}

/**
 * 수집기 → 해석기 → 분배기.
 *
 * passthrough 채널은 해석 없이 이벤트가 곧 Task가 된다 (문맥 스레드를 만들지 않는다).
 * llm 채널은 이벤트를 문맥 스레드에 쌓고, 잠잠해지면(debounce) 해석기를 돌려
 * fast_pass·complete면 Task를 만들고, noise면 폐기하고, needs_context면 더 기다린다.
 */
export class Pipeline {
  /** 해석 중인 스레드 — 타이머와 주기 스캔이 겹쳐도 두 번 돌지 않게 한다. */
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly channels: ChannelLookup,
    private readonly threads: ThreadStore,
    private readonly tasks: TaskStore,
    private readonly log: PipelineLog,
  ) {}

  async ingest(
    channelId: string,
    payload: string,
    opts: { agent?: string; contextKey?: string } = {},
  ): Promise<IngestResult> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`unknown channel: ${channelId}`);

    if (channel.config.interpreter.mode === 'passthrough') {
      const task = await this.tasks.createTask(channelId, channel.label, payload, opts.agent);
      return { taskId: task.id, threadId: null };
    }

    // 문맥 키가 없으면 이벤트마다 새 스레드를 연다 (소스가 키를 주지 않는 경우).
    const contextKey = opts.contextKey ?? randomUUID();
    const thread = this.threads.append(channelId, contextKey, payload, opts.agent);
    this.scheduleInterpretation(channelId, channel.config.interpreter.debounceMs);
    return { taskId: null, threadId: thread.id };
  }

  /** debounce가 지난 뒤 한 번 돌도록 예약한다. 주기 스캔과 같은 함수로 수렴한다. */
  private scheduleInterpretation(channelId: string, debounceMs: number): void {
    const existing = this.timers.get(channelId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(channelId);
      void this.runDue(channelId).catch((err) =>
        this.log.error({ channelId, err: String(err) }, 'interpretation run failed'),
      );
    }, debounceMs + 50);
    timer.unref?.();
    this.timers.set(channelId, timer);
  }

  /** 한 채널에서 해석할 때가 된 스레드를 전부 처리한다. */
  async runDue(channelId: string): Promise<number> {
    const channel = this.channels.get(channelId);
    if (!channel || channel.config.interpreter.mode === 'passthrough') return 0;

    const due = this.threads.dueForInterpretation(channelId, channel.config.interpreter.debounceMs);
    let handled = 0;
    for (const thread of due) {
      if (this.inFlight.has(thread.id)) continue;
      this.inFlight.add(thread.id);
      try {
        await this.interpretThread(channel, thread);
        handled++;
      } finally {
        this.inFlight.delete(thread.id);
      }
    }
    return handled;
  }

  private async interpretThread(channel: ChannelRuntime, thread: ContextThread): Promise<void> {
    // 해석 도중 새 이벤트가 붙을 수 있으므로, 지금 보고 있는 지점을 먼저 잡아둔다.
    const interpretedSeq = thread.eventSeq;
    const events = this.threads.events(thread.id);
    const labels =
      channel.config.interpreter.labels.length > 0
        ? channel.config.interpreter.labels
        : [channel.label];

    let verdict;
    try {
      verdict = await channel.interpreter.interpret({
        channelId: channel.config.id,
        labels,
        events: events.map((e) => ({ at: e.receivedAt, payload: e.payload })),
      });
    } catch (err) {
      // 해석에 실패하면 판정을 남기지 않는다 — 다음 주기 스캔에서 다시 시도하고,
      // 끝내 안 되면 채널 TTL이 스레드를 닫는다.
      this.log.error(
        { threadId: thread.id, err: String(err) },
        'interpreter failed; will retry on next sweep',
      );
      return;
    }

    this.threads.markInterpreted(thread.id, interpretedSeq);

    switch (verdict.verdict) {
      case 'needs_context':
        this.log.info({ threadId: thread.id, reason: verdict.reason }, 'thread needs more context');
        return;
      case 'noise':
        this.threads.close(thread.id, 'discarded');
        this.log.info({ threadId: thread.id, reason: verdict.reason }, 'thread discarded as noise');
        return;
      case 'fast_pass':
      case 'complete': {
        const task = await this.tasks.createTask(
          channel.config.id,
          verdict.label,
          verdict.instruction,
          thread.agent ?? undefined,
          thread.id,
        );
        this.threads.close(thread.id, 'dispatched');
        this.log.info(
          { threadId: thread.id, taskId: task.id, verdict: verdict.verdict, label: verdict.label },
          'thread dispatched',
        );
        return;
      }
    }
  }

  /** 주기 스캔: 채널별 TTL 만료 처리 + 밀린 해석 실행. */
  async sweep(): Promise<void> {
    for (const [channelId, channel] of this.channels) {
      if (channel.config.interpreter.mode === 'passthrough') continue;
      const expired = this.threads.expireStale(channelId, channel.config.interpreter.ttlSeconds);
      if (expired.length > 0) {
        this.log.info({ channelId, expired: expired.length }, 'context threads expired');
      }
      await this.runDue(channelId);
    }
  }
}
