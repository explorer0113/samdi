import { Fragment, useCallback, useEffect, useState } from 'react';
import type { TaskSummary } from '@samdi/protocol';
import { api, type AgentsInfo, type TaskDetail, type UiState } from './api.js';

const PHASE_LABEL: Record<string, string> = {
  gate: 'Start Gate 판정 중',
  agent_running: '에이전트 실행 중',
  awaiting_approval: '승인 대기 중',
  reporting: '결과 보고 중',
};

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
}

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [agents, setAgents] = useState<AgentsInfo | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 진행 중인 Task만 받는다 — 종결분까지 초 단위로 실어 나를 이유가 없다.
      const [s, t] = await Promise.all([api.state(), api.tasks()]);
      setState(s);
      setTasks(t.tasks); // 서버가 최신순으로 준다
      setError(null);
    } catch (err) {
      setError(`Worker 로컬 API에 연결할 수 없습니다 (${String(err)}). worker가 떠 있나요?`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.agents().then(setAgents).catch(() => {});
    // 보이지 않는 탭은 폴링하지 않는다. 다시 보일 때 즉시 한 번 당겨온다.
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(tick, 1500);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      api
        .task(selectedId)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => {});
    };
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId]);

  const resolve = async (taskId: string, action: 'retry' | 'abandon') => {
    try {
      await api.resolve(taskId, action);
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * 사람이 직접 종료 처리한다. 에이전트가 보고 없이 끝났을 때 쓴다 —
   * 두면 lease가 만료될 때까지(기본 10분) Worker가 묶여 뒤가 막힌다.
   */
  const finish = async (taskId: string, outcome: 'completed' | 'failed') => {
    const what = outcome === 'completed' ? '완료로 처리' : '종료';
    if (!confirm(`이 Task를 ${what}할까요?\n에이전트가 아니라 사람이 처리했다고 기록됩니다.`)) {
      return;
    }
    try {
      await api.finish(taskId, outcome);
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const approve = async (taskId: string, decision: 'approve' | 'deny') => {
    try {
      await api.approve(taskId, decision);
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  /** 그 Task가 사용자 결정을 기다리는 중이면 그 승인 정보 */
  const approvalOf = (taskId: string) => state?.approvals.find((a) => a.taskId === taskId);

  const setAgent = async (taskId: string, agent: string) => {
    try {
      await api.setAgent(taskId, agent);
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>samdi worker</h1>
        <span className="meta">
          <span className={`dot ${state ? 'on' : 'off'}`} aria-hidden />
          {state ? (
            <>
              {state.workerId} · 라벨 {state.labels.join(', ')} · {state.controlPlaneUrl}
            </>
          ) : (
            '연결 안 됨'
          )}
        </span>
        <span className="spacer" />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid">
        <div className="stack">
          {state && <Labels state={state} onError={setError} onChanged={refresh} />}

          <section className="card">
            <h2>지금 처리 중 {state ? `(${state.current.length}/${state.concurrency})` : ''}</h2>
            {state && state.current.length > 0 ? (
              state.current.map((c) => (
                <div className="current-task" key={c.taskId}>
                  <span className="phase">{PHASE_LABEL[c.phase] ?? c.phase}</span>
                  <span className="mono">{c.taskId}</span>
                  <span>
                    라벨 {c.label} · {timeOf(c.startedAt)} 시작
                  </span>
                  {/* 에이전트가 보고 없이 끝나면 여기서 사람이 풀어줘야 한다 —
                      안 그러면 lease가 만료될 때까지 이 Task가 Worker를 붙든다.
                      아직 시작 전(승인 대기)이면 목록 행의 승인/거부가 맞는 행동이므로
                      여기서는 보여주지 않는다. */}
                  {c.phase !== 'awaiting_approval' && (
                    <div className="finish-actions">
                      <button
                        className="small approve"
                        title="에이전트가 일은 마쳤는데 보고를 안 한 경우"
                        onClick={() => void finish(c.taskId, 'completed')}
                      >
                        완료로 처리
                      </button>{' '}
                      <button
                        className="small danger"
                        title="에이전트가 죽었거나 포기하는 경우"
                        onClick={() => void finish(c.taskId, 'failed')}
                      >
                        종료
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="current-idle">대기 중 — 다음 Task를 폴링하고 있습니다.</p>
            )}
            {state && (
              <Concurrency state={state} onError={setError} onChanged={refresh} />
            )}
          </section>

          <section className="card">
            <h2>활동 로그</h2>
            {state && state.activity.length > 0 ? (
              <ul className="activity">
                {state.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`}>
                    <span className="t">{timeOf(a.at)}</span>
                    <span>{a.type}</span>
                    {a.detail && <span className="detail">{a.detail}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">아직 활동이 없습니다.</p>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <h2>진행 중인 Task</h2>
            {tasks.length === 0 ? (
              <p className="empty">
                진행 중인 Task가 없습니다.
                <br />
                이 화면은 <b>이 기기에서 벌어지는 일</b>만 보여줍니다 — 완료·실패·기각된 Task와
                채널 관리는 Control Plane 화면에 있습니다.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>상태</th>
                    <th>내용</th>
                    <th>에이전트</th>
                    <th>ID</th>
                    <th>라벨</th>
                    <th>갱신</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <Fragment key={t.id}>
                    <tr
                      className={t.id === selectedId ? 'selected' : ''}
                      onClick={() => setSelectedId(t.id)}
                    >
                      <td>
                        <span className={`chip ${t.status}`}>{t.status}</span>
                      </td>
                      <td className="preview" title={t.preview}>
                        {t.preview}
                      </td>
                      <td className="agent-cell">
                        {/* pending이면 서버에, 승인 대기 중이면 Worker에 지정된다.
                            어댑터는 승인 이후에 정해지므로 후자도 실제로 반영된다 —
                            pending인 2초 남짓을 노리지 않아도 된다. */}
                        {(t.status === 'pending' || approvalOf(t.id)) && agents ? (
                          <select
                            value={approvalOf(t.id)?.agent ?? t.agent ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              if (e.target.value) void setAgent(t.id, e.target.value);
                            }}
                          >
                            <option value="">기본 ({agents.default})</option>
                            {agents.agents.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="mono">{t.agent ?? `기본(${agents?.default ?? ''})`}</span>
                        )}
                      </td>
                      <td className="mono">{t.id.slice(0, 8)}</td>
                      <td>{t.label}</td>
                      <td className="mono">{timeOf(t.updatedAt)}</td>
                      <td className="actions">
                        {approvalOf(t.id) && (
                          <>
                            <button
                              className="small approve"
                              title={approvalOf(t.id)!.question}
                              onClick={(e) => {
                                e.stopPropagation();
                                void approve(t.id, 'approve');
                              }}
                            >
                              승인
                            </button>{' '}
                            <button
                              className="small danger"
                              title={approvalOf(t.id)!.question}
                              onClick={(e) => {
                                e.stopPropagation();
                                void approve(t.id, 'deny');
                              }}
                            >
                              거부
                            </button>
                          </>
                        )}
                        {t.status === 'stalled' && (
                          <>
                            <button
                              className="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                void resolve(t.id, 'retry');
                              }}
                            >
                              재시도
                            </button>{' '}
                            <button
                              className="small danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                void resolve(t.id, 'abandon');
                              }}
                            >
                              포기
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {approvalOf(t.id) && (
                      <tr className="question-row">
                        <td colSpan={7}>{approvalOf(t.id)!.question}</td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {detail && (
            <section className="card">
              <h2>Task 상세</h2>
              <div className="detail-head">
                <span className={`chip ${detail.task.status}`}>{detail.task.status}</span>
                <span className="mono">{detail.task.id}</span>
                {detail.task.workerId && <span className="mono">worker: {detail.task.workerId}</span>}
              </div>
              {detail.payload && <div className="payload">{detail.payload}</div>}
              <ul className="timeline">
                {detail.events.map((e) => (
                  <li key={e.id}>
                    <span className="t">{timeOf(e.at)}</span>
                    <span className="type">{e.type}</span>
                    <span className="data">
                      {Object.keys(e.data).length > 0 ? JSON.stringify(e.data) : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 이 Worker가 받을 라벨. 채널은 운영 중에 생기므로, 새 채널의 일을 받으려고
 * 매번 재시작할 수는 없다. 바꾸면 다음 claim부터 적용된다.
 *
 * 라벨을 여기서 정하는 이유는 이게 **이 기기의 결정**이기 때문이다 —
 * 무슨 일을 받을지는 자격 증명과 도구를 가진 쪽이 정한다.
 */
function Labels({
  state,
  onError,
  onChanged,
}: {
  state: UiState;
  onError: (msg: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const start = () => {
    setDraft(state.labels.join(', '));
    setEditing(true);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setLabels(draft.split(',').map((l) => l.trim()).filter(Boolean));
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      await api.resetLabels();
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>받는 라벨</h2>
        {!editing && (
          <button className="small" onClick={start}>
            변경
          </button>
        )}
      </div>

      {!editing && <DefaultAgent state={state} onError={onError} onChanged={onChanged} />}

      {editing ? (
        <>
          <div className="inject">
            <input
              value={draft}
              placeholder="콤마로 구분 (예: demo, mail)"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 한글 IME 조합 확정 시 keydown이 한 번 더 오므로 걸러야 두 번 저장되지 않는다
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button className="primary" disabled={busy} onClick={() => void save()}>
              저장
            </button>
            <button className="small" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
          <p className="hint">
            채널의 <b>label</b>과 맞아야 그 채널의 Task를 가져옵니다. 저장하면 다음 claim부터
            적용됩니다 — 재시작할 필요 없습니다.
          </p>
        </>
      ) : (
        <>
          <div className="label-chips">
            {state.labels.map((l) => (
              <span className="chip running" key={l}>
                {l}
              </span>
            ))}
          </div>
          {state.overridden.labels && (
            <p className="hint">
              설정 파일 값(<code>{state.configured.labels.join(', ')}</code>)과 다릅니다.{' '}
              <button className="small" onClick={() => void reset()}>
                설정값으로 되돌리기
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * 한 번에 몇 건까지 감당할지. 1이면 사람을 기다리는 작업 하나가 뒤를 전부 막는다 —
 * 승인이 끼어 있는 구조에서는 실제로 자주 겪는 일이다.
 */
function Concurrency({
  state,
  onError,
  onChanged,
}: {
  state: UiState;
  onError: (msg: string) => void;
  onChanged: () => Promise<void>;
}) {
  const change = async (next: number) => {
    if (next < 1 || next > 32) return;
    try {
      await api.setConcurrency(next);
      await onChanged();
    } catch (err) {
      onError(String(err));
    }
  };

  // 줄이는 중이면 진행 중인 일이 끝날 때까지 실제 루프 수가 더 많다.
  const shrinking = state.runningLoops > state.concurrency;

  return (
    <div className="concurrency">
      <span>동시 처리</span>
      <button className="small" onClick={() => void change(state.concurrency - 1)}>
        −
      </button>
      <b>{state.concurrency}</b>
      <button className="small" onClick={() => void change(state.concurrency + 1)}>
        +
      </button>
      {shrinking && (
        <span className="detail">진행 중인 {state.runningLoops}건이 끝나면 반영됩니다</span>
      )}
      {state.overridden.concurrency && !shrinking && (
        <span className="detail">설정값 {state.configured.concurrency}</span>
      )}
    </div>
  );
}

/**
 * 기본 에이전트. Task마다 드롭다운으로 고르는 건 pending인 2초 남짓을 노려야 해서
 * 잘 안 먹는다 — "내 일은 다 이걸로 돌린다"는 여기서 한 번 정한다.
 */
function DefaultAgent({
  state,
  onError,
  onChanged,
}: {
  state: UiState;
  onError: (msg: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<AgentsInfo | null>(null);

  useEffect(() => {
    api.agents().then(setAgents).catch(() => {});
  }, [state.defaultAgent]);

  const change = async (agent: string) => {
    try {
      await api.setDefaultAgent(agent);
      await onChanged();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <div className="default-agent">
      <span>기본 에이전트</span>
      <select
        value={state.defaultAgent}
        onChange={(e) => void change(e.target.value)}
        aria-label="기본 에이전트"
      >
        {(agents?.agents ?? [state.defaultAgent]).map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      {state.overridden.defaultAgent && (
        <span className="detail">설정값 {state.configured.defaultAgent}</span>
      )}
    </div>
  );
}
