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
  const [payload, setPayload] = useState('');
  const [injectAgent, setInjectAgent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.state(), api.tasks()]);
      setState(s);
      setTasks(t.tasks.slice().reverse()); // 최신 먼저
      setError(null);
    } catch (err) {
      setError(`Worker 로컬 API에 연결할 수 없습니다 (${String(err)}). worker가 떠 있나요?`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.agents().then(setAgents).catch(() => {});
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .task(selectedId)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId]);

  const [injecting, setInjecting] = useState(false);
  const inject = async () => {
    if (!payload.trim() || injecting) return;
    setInjecting(true);
    try {
      const { taskId } = await api.inject(payload.trim(), injectAgent || undefined);
      setPayload('');
      setSelectedId(taskId);
      void refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setInjecting(false);
    }
  };

  const resolve = async (taskId: string, action: 'retry' | 'abandon') => {
    try {
      await api.resolve(taskId, action);
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
          <section className="card">
            <h2>지금 처리 중</h2>
            {state?.current ? (
              <div className="current-task">
                <span className="phase">{PHASE_LABEL[state.current.phase] ?? state.current.phase}</span>
                <span className="mono">{state.current.taskId}</span>
                <span>
                  라벨 {state.current.label} · {timeOf(state.current.startedAt)} 시작
                </span>
              </div>
            ) : (
              <p className="current-idle">대기 중 — 다음 Task를 폴링하고 있습니다.</p>
            )}
          </section>

          <section className="card">
            <h2>데모: 이벤트 주입</h2>
            <div className="inject">
              <input
                value={payload}
                placeholder="예: 내일 오전 회의 일정 잡아줘"
                onChange={(e) => setPayload(e.target.value)}
                onKeyDown={(e) => {
                  // 한글 IME 조합 확정 시 keydown이 한 번 더 발생하므로 걸러야 중복 주입이 없다
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void inject();
                }}
              />
              <select
                className="inject-agent"
                value={injectAgent}
                onChange={(e) => setInjectAgent(e.target.value)}
                aria-label="처리할 에이전트"
              >
                <option value="">기본 ({agents?.default ?? '...'})</option>
                {agents?.agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={injecting} onClick={() => void inject()}>
                전송
              </button>
            </div>
            <p className="hint">"승인"이 포함된 내용은 mock 에이전트가 승인을 요청합니다.</p>
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
            <h2>Task 목록</h2>
            {tasks.length === 0 ? (
              <p className="empty">Task가 없습니다. 왼쪽에서 이벤트를 주입해보세요.</p>
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
                        {t.status === 'pending' && agents ? (
                          <select
                            value={t.agent ?? ''}
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
                        {state?.approval?.taskId === t.id && (
                          <>
                            <button
                              className="small approve"
                              title={state.approval.question}
                              onClick={(e) => {
                                e.stopPropagation();
                                void approve(t.id, 'approve');
                              }}
                            >
                              승인
                            </button>{' '}
                            <button
                              className="small danger"
                              title={state.approval.question}
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
                    {state?.approval?.taskId === t.id && (
                      <tr className="question-row">
                        <td colSpan={7}>{state.approval.question}</td>
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
