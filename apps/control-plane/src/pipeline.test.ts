import { beforeEach, describe, expect, it } from 'vitest';
import { interpreterConfigSchema, type InterpreterConfig } from '@samdi/config';
import type { Interpreter, InterpretInput } from '@samdi/interpreter';
import type { InterpretVerdict } from '@samdi/protocol';
import { openDb, type Db } from './db.js';
import { Pipeline, type ChannelRuntime } from './pipeline.js';
import { SqlitePayloadStore, TaskStore } from './task-store.js';
import { ThreadStore } from './thread-store.js';

const noopLog = { info: () => {}, error: () => {} };

/** 판정을 시험이 정해주는 해석기 */
class ScriptedInterpreter implements Interpreter {
  readonly calls: InterpretInput[] = [];
  constructor(private readonly verdicts: InterpretVerdict[]) {}
  async interpret(input: InterpretInput): Promise<InterpretVerdict> {
    this.calls.push(input);
    return this.verdicts.shift() ?? { verdict: 'needs_context', reason: '대본 소진' };
  }
}

let db: Db;
let threads: ThreadStore;
let tasks: TaskStore;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO channels (id, label, key) VALUES (?, ?, ?)').run('demo', 'demo', 'k');
  threads = new ThreadStore(db);
  tasks = new TaskStore(db, new SqlitePayloadStore(db));
});

function mkPipeline(interpreter: Interpreter, overrides: Partial<InterpreterConfig> = {}) {
  const config = interpreterConfigSchema.parse({ debounceMs: 0, ...overrides });
  const channels = new Map<string, ChannelRuntime>([
    [
      'demo',
      { config: { id: 'demo', label: 'demo', key: 'k', interpreter: config }, label: 'demo', interpreter },
    ],
  ]);
  return new Pipeline(channels, threads, tasks, noopLog);
}

describe('passthrough 모드', () => {
  it('LLM 없이 이벤트가 곧 Task가 된다 — 스레드를 만들지 않는다', async () => {
    const interpreter = new ScriptedInterpreter([]);
    const pipeline = mkPipeline(interpreter, { mode: 'passthrough' });

    const out = await pipeline.ingest('demo', '회의 잡아줘');
    expect(out.taskId).not.toBeNull();
    expect(out.threadId).toBeNull();
    expect(interpreter.calls).toHaveLength(0);
    expect(threads.listByChannel('demo')).toHaveLength(0);

    const detail = await tasks.getTaskDetail(out.taskId!);
    expect(detail.payload).toBe('회의 잡아줘');
    expect(detail.task.label).toBe('demo');
  });
});

describe('해석 모드 (claude)', () => {
  it('이벤트는 문맥 스레드에 쌓이고 Task는 아직 생기지 않는다', async () => {
    const pipeline = mkPipeline(new ScriptedInterpreter([]), { mode: 'claude', debounceMs: 60_000 });
    const out = await pipeline.ingest('demo', '첫 메일');
    expect(out.taskId).toBeNull();
    expect(out.threadId).not.toBeNull();
    expect(tasks.listTasks()).toHaveLength(0);
    expect(threads.get(out.threadId!)?.status).toBe('open');
  });

  it('같은 문맥 키는 한 스레드로 모인다', async () => {
    const pipeline = mkPipeline(new ScriptedInterpreter([]), { mode: 'claude', debounceMs: 60_000 });
    const a = await pipeline.ingest('demo', '첫 메일', { contextKey: 'chain-1' });
    const b = await pipeline.ingest('demo', '답장', { contextKey: 'chain-1' });
    expect(b.threadId).toBe(a.threadId);
    expect(threads.events(a.threadId!).map((e) => e.payload)).toEqual(['첫 메일', '답장']);
  });

  it('문맥 키가 없으면 이벤트마다 새 스레드가 열린다', async () => {
    const pipeline = mkPipeline(new ScriptedInterpreter([]), { mode: 'claude', debounceMs: 60_000 });
    const a = await pipeline.ingest('demo', 'x');
    const b = await pipeline.ingest('demo', 'y');
    expect(b.threadId).not.toBe(a.threadId);
  });

  it('needs_context면 스레드가 열린 채 남고 Task는 없다', async () => {
    const interpreter = new ScriptedInterpreter([{ verdict: 'needs_context', reason: '아직' }]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude' });
    const { threadId } = await pipeline.ingest('demo', '음...', { contextKey: 'k' });

    await pipeline.runDue('demo');
    expect(tasks.listTasks()).toHaveLength(0);
    expect(threads.get(threadId!)?.status).toBe('open');
  });

  it('complete면 해석된 지시로 Task를 만들고 스레드를 닫는다', async () => {
    const interpreter = new ScriptedInterpreter([
      { verdict: 'complete', label: 'coding', instruction: '로그인 버그를 고쳐라' },
    ]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude', labels: ['coding', 'ops'] });
    const { threadId } = await pipeline.ingest('demo', '로그인이 안 돼요', { contextKey: 'k' });
    await pipeline.ingest('demo', '크롬에서만 그래요', { contextKey: 'k' });

    await pipeline.runDue('demo');

    const all = tasks.listTasks();
    expect(all).toHaveLength(1);
    expect(all[0]?.label).toBe('coding');
    expect(all[0]?.threadId).toBe(threadId);
    // Task 본문은 원문이 아니라 해석기가 정리한 지시다
    const detail = await tasks.getTaskDetail(all[0]!.id);
    expect(detail.payload).toBe('로그인 버그를 고쳐라');
    expect(threads.get(threadId!)?.status).toBe('dispatched');
    // 해석기는 스레드에 쌓인 이벤트 전부와 라벨 카탈로그를 받는다
    expect(interpreter.calls[0]?.events.map((e) => e.payload)).toEqual([
      '로그인이 안 돼요',
      '크롬에서만 그래요',
    ]);
    expect(interpreter.calls[0]?.labels).toEqual(['coding', 'ops']);
  });

  it('noise면 폐기하고 Task를 만들지 않는다', async () => {
    const interpreter = new ScriptedInterpreter([{ verdict: 'noise', reason: '자동 알림' }]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude' });
    const { threadId } = await pipeline.ingest('demo', '[자동] 백업 완료', { contextKey: 'k' });

    await pipeline.runDue('demo');
    expect(tasks.listTasks()).toHaveLength(0);
    expect(threads.get(threadId!)?.status).toBe('discarded');
  });

  it('같은 이벤트를 두 번 해석하지 않는다', async () => {
    const interpreter = new ScriptedInterpreter([{ verdict: 'needs_context', reason: '' }]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude' });
    await pipeline.ingest('demo', 'x', { contextKey: 'k' });

    await pipeline.runDue('demo');
    await pipeline.runDue('demo'); // 새 이벤트가 없으면 다시 돌지 않는다
    expect(interpreter.calls).toHaveLength(1);

    await pipeline.ingest('demo', 'y', { contextKey: 'k' }); // 새 이벤트가 오면 다시 판정
    await pipeline.runDue('demo');
    expect(interpreter.calls).toHaveLength(2);
  });

  it('debounce가 지나지 않은 스레드는 해석하지 않는다', async () => {
    const interpreter = new ScriptedInterpreter([]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude', debounceMs: 60_000 });
    await pipeline.ingest('demo', 'x', { contextKey: 'k' });
    await pipeline.runDue('demo');
    expect(interpreter.calls).toHaveLength(0);
  });

  it('해석기가 실패하면 판정을 남기지 않고 다음 스캔에서 재시도한다', async () => {
    const failing: Interpreter = {
      calls: 0,
      async interpret() {
        this.calls++;
        throw new Error('API 실패');
      },
    } as Interpreter & { calls: number };
    const pipeline = mkPipeline(failing, { mode: 'claude' });
    const { threadId } = await pipeline.ingest('demo', 'x', { contextKey: 'k' });

    await pipeline.runDue('demo');
    expect(threads.get(threadId!)?.status).toBe('open');
    expect(threads.get(threadId!)?.lastInterpretedAt).toBeNull();

    // 같은 스레드가 여전히 해석 대상으로 남아 있다
    expect(threads.dueForInterpretation('demo', 0)).toHaveLength(1);
  });

  it('TTL이 지나면 스레드를 expired로 닫는다', async () => {
    const pipeline = mkPipeline(new ScriptedInterpreter([]), {
      mode: 'claude',
      ttlSeconds: 1,
      debounceMs: 60_000,
    });
    const { threadId } = await pipeline.ingest('demo', 'x', { contextKey: 'k' });
    // 마지막 이벤트 시각을 과거로 조작해 TTL 만료를 흉내낸다
    db.prepare('UPDATE context_threads SET last_event_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10_000).toISOString(),
      threadId,
    );

    await pipeline.sweep();
    expect(threads.get(threadId!)?.status).toBe('expired');

    // 만료된 스레드는 더 이상 이벤트를 받지 않는다 — 같은 키로 새 스레드가 열린다
    const next = await pipeline.ingest('demo', 'y', { contextKey: 'k' });
    expect(next.threadId).not.toBe(threadId);
  });

  it('첫 이벤트가 지정한 에이전트가 분배될 Task로 넘어간다', async () => {
    const interpreter = new ScriptedInterpreter([
      { verdict: 'fast_pass', label: 'demo', instruction: '해줘' },
    ]);
    const pipeline = mkPipeline(interpreter, { mode: 'claude' });
    await pipeline.ingest('demo', 'x', { contextKey: 'k', agent: 'claude-code' });

    await pipeline.runDue('demo');
    expect(tasks.listTasks()[0]?.agent).toBe('claude-code');
  });
});
