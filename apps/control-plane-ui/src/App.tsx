import { useCallback, useEffect, useState } from 'react';
import type { TaskSummary } from '@samdi/protocol';
import {
  api,
  ChannelInUseError,
  clearKey,
  loadKey,
  saveKey,
  UnauthorizedError,
  type ChannelRow,
  type Overview,
  type TaskDetail,
} from './api.js';

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
}

/** 진행 중으로 볼 상태들. 나머지는 종결분이다. */
const ACTIVE = ['pending', 'claimed', 'running', 'waiting', 'stalled'];

/** 관리 키를 받는 화면. 키가 없거나 틀렸을 때만 나온다. */
function KeyGate({ onSubmit, error }: { onSubmit: (key: string) => void; error: string | null }) {
  const [value, setValue] = useState('');
  return (
    <div className="gate">
      <h1>samdi control plane</h1>
      <p className="hint">
        관리 키를 입력하세요. 서버 설정의 <code>adminKey</code>입니다
        (환경변수 <code>SAMDI_ADMIN_KEY</code>).
      </p>
      {error && <div className="error-banner">{error}</div>}
      <div className="inject">
        <input
          type="password"
          value={value}
          placeholder="adminKey"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 한글 IME 조합 확정 시 keydown이 한 번 더 오므로 걸러야 두 번 발화하지 않는다
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && value.trim()) {
              onSubmit(value.trim());
            }
          }}
        />
        <button className="primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
          연결
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(() => loadKey() !== null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [view, setView] = useState<'all' | 'active'>('all');
  const [error, setError] = useState<string | null>(null);

  /** 발급 직후 한 번만 보여주는 평문 키. 새로고침하면 다시 볼 수 없다. */
  const [issuedKey, setIssuedKey] = useState<{ channelId: string; key: string } | null>(null);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) {
      clearKey();
      setAuthed(false);
      setAuthError('관리 키가 올바르지 않습니다. 다시 입력하세요.');
      return;
    }
    setError(String(err));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [o, c, t] = await Promise.all([api.overview(), api.channels(), api.tasks(view)]);
      setOverview(o);
      setChannels(c.channels);
      setTasks(t.tasks);
      setError(null);
    } catch (err) {
      handleError(err);
    }
  }, [view, handleError]);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    // 보이지 않는 탭은 폴링하지 않는다. 다시 보일 때 즉시 한 번 당겨온다.
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(tick, 3000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [authed, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .task(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(handleError);
    return () => {
      cancelled = true;
    };
  }, [selectedId, handleError]);

  if (!authed) {
    return (
      <KeyGate
        error={authError}
        onSubmit={(key) => {
          saveKey(key);
          setAuthError(null);
          setAuthed(true);
        }}
      />
    );
  }

  const taskCount = (statuses: string[]) =>
    statuses.reduce((sum, s) => sum + (overview?.tasks[s] ?? 0), 0);

  return (
    <div className="app admin">
      <div className="topbar">
        <h1>samdi control plane</h1>
        <span className="meta">
          <span className={`dot ${overview ? 'on' : 'off'}`} aria-hidden />
          {overview
            ? `채널 ${overview.channels} · Worker ${overview.workers.length} · Task ${taskCount(Object.keys(overview.tasks))}`
            : '연결 안 됨'}
        </span>
        <span className="spacer" />
        <button
          className="small"
          onClick={() => {
            clearKey();
            setAuthed(false);
          }}
        >
          연결 해제
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid">
        <div className="stack">
          <Overviews overview={overview} active={taskCount(ACTIVE)} />
          <Channels
            channels={channels}
            coveredLabels={overview?.coveredLabels ?? null}
            issuedKey={issuedKey}
            onIssued={setIssuedKey}
            onError={handleError}
            onChanged={refresh}
          />
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Task</h2>
              <div className="toggle">
                <button
                  className={`small ${view === 'all' ? 'on' : ''}`}
                  onClick={() => setView('all')}
                >
                  전체
                </button>
                <button
                  className={`small ${view === 'active' ? 'on' : ''}`}
                  onClick={() => setView('active')}
                >
                  진행 중
                </button>
              </div>
            </div>
            {tasks.length === 0 ? (
              <p className="empty">Task가 없습니다. 왼쪽 채널에서 이벤트를 넣어보세요.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>상태</th>
                    <th>내용</th>
                    <th>라벨</th>
                    <th>에이전트</th>
                    <th>Worker</th>
                    <th>갱신</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      className={t.id === selectedId ? 'selected' : ''}
                      onClick={() => setSelectedId(t.id)}
                    >
                      <td>
                        <span className={`chip ${t.status}`}>{t.status}</span>
                      </td>
                      <td className="preview" title={t.preview}>
                        {t.preview}
                      </td>
                      <td>
                        {t.label}
                        {/* pending인데 아무도 이 라벨을 안 보면 영영 안 움직인다 */}
                        {t.status === 'pending' &&
                          overview !== null &&
                          !overview.coveredLabels.includes(t.label) && (
                            <span
                              className="chip stalled orphan"
                              title={`이 라벨을 보는 Worker가 없어서 시작되지 않습니다. Worker의 worker.labels에 "${t.label}"을 추가하세요.`}
                            >
                              Worker 없음
                            </span>
                          )}
                      </td>
                      <td className="mono">{t.agent ?? '기본'}</td>
                      <td className="mono">{t.workerId ?? '—'}</td>
                      <td className="mono">{timeOf(t.updatedAt)}</td>
                    </tr>
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
                {detail.task.workerId && (
                  <span className="mono">worker: {detail.task.workerId}</span>
                )}
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

/** 폴링 주기보다 넉넉하게 잡는다 — 일하는 동안에는 claim을 쉬므로 잠깐 멀어진다. */
const WORKER_ONLINE_SECONDS = 60;

function isOnline(lastSeenAt: string): boolean {
  return Date.now() - Date.parse(lastSeenAt) < WORKER_ONLINE_SECONDS * 1000;
}

function Overviews({ overview, active }: { overview: Overview | null; active: number }) {
  if (!overview) return null;
  const statuses = Object.entries(overview.tasks).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="card">
      <h2>전체 현황</h2>
      <div className="stats">
        <div className="stat">
          <span className="n">{active}</span>
          <span className="k">진행 중</span>
        </div>
        {statuses.map(([status, n]) => (
          <div className="stat" key={status}>
            <span className="n">{n}</span>
            <span className={`k chip ${status}`}>{status}</span>
          </div>
        ))}
      </div>

      <h3>Worker</h3>
      {overview.workers.length === 0 ? (
        <p className="empty">아직 붙은 Worker가 없습니다. Task를 만들어도 아무도 가져가지 않습니다.</p>
      ) : (
        <ul className="activity">
          {overview.workers.map((w) => (
            <li key={w.workerId}>
              <span className={`dot ${isOnline(w.lastSeenAt) ? 'on' : 'off'}`} aria-hidden />
              <span className="mono">{w.workerId}</span>
              <span className="mono worker-labels">{w.labels.join(', ')}</span>
              <span className="detail">
                {w.inFlight > 0
                  ? `${w.inFlight}건 처리 중`
                  : isOnline(w.lastSeenAt)
                    ? '대기 중'
                    : `${timeOf(w.lastSeenAt)} 이후 조용함`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Worker가 claim할 때 알려온 라벨입니다. <b>여기 없는 라벨</b>로 만든 Task는 아무도
        가져가지 않고 <code>pending</code>에 남습니다.
      </p>
    </section>
  );
}

function Channels({
  channels,
  coveredLabels,
  issuedKey,
  onIssued,
  onError,
  onChanged,
}: {
  channels: ChannelRow[];
  /** null이면 아직 모른다 — 모르는 상태에서 경고하지 않는다 */
  coveredLabels: string[] | null;
  issuedKey: { channelId: string; key: string } | null;
  onIssued: (v: { channelId: string; key: string } | null) => void;
  onError: (err: unknown) => void;
  onChanged: () => Promise<void>;
}) {
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [mode, setMode] = useState<'passthrough' | 'claude'>('passthrough');
  const [busy, setBusy] = useState(false);
  const [injectTo, setInjectTo] = useState<string | null>(null);
  const [payload, setPayload] = useState('');

  // 라벨을 안 고르면 첫 번째 커버된 라벨을 쓴다. 라벨을 비워두면 id가 라벨이 되는데
  // 그러면 아무도 안 보는 채널이 만들어지므로, 기본값을 "도는 쪽"으로 둔다.
  const labelFallback = coveredLabels?.[0] ?? '';
  const effectiveLabel = newLabel.trim() || labelFallback;
  const willBeOrphan = coveredLabels !== null && !coveredLabels.includes(effectiveLabel || newId.trim());

  const create = async () => {
    if (!newId.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.createChannel({
        id: newId.trim(),
        ...(effectiveLabel ? { label: effectiveLabel } : {}),
        interpreter: { mode },
      });
      onIssued({ channelId: res.channel.id, key: res.key });
      setNewId('');
      setNewLabel('');
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (id: string) => {
    try {
      const { key } = await api.rotateKey(id);
      onIssued({ channelId: id, key });
      await onChanged();
    } catch (err) {
      onError(err);
    }
  };

  const disable = async (id: string) => {
    try {
      await api.disableChannel(id);
      await onChanged();
    } catch (err) {
      onError(err);
    }
  };

  /**
   * 삭제. 걸린 기록이 없으면 바로 지우고, 있으면 서버가 몇 건인지 알려주므로
   * 그걸 보여주고 확인받은 뒤에만 기록째 지운다 (되돌릴 수 없다).
   */
  const remove = async (id: string) => {
    try {
      await api.deleteChannel(id);
      await onChanged();
    } catch (err) {
      if (!(err instanceof ChannelInUseError)) return onError(err);
      const { tasks, threads } = err.refs;
      const what = [
        tasks > 0 ? `Task ${tasks}건(본문·감사 이벤트 포함)` : null,
        threads > 0 ? `문맥 스레드 ${threads}건` : null,
      ]
        .filter(Boolean)
        .join('과 ');
      if (!confirm(`"${id}"를 지우면 ${what}도 함께 사라집니다.\n되돌릴 수 없습니다. 계속할까요?`)) {
        return;
      }
      try {
        await api.deleteChannel(id, true);
        await onChanged();
      } catch (err2) {
        onError(err2);
      }
    }
  };

  const inject = async () => {
    if (!injectTo || !payload.trim()) return;
    try {
      await api.inject(injectTo, payload.trim());
      setPayload('');
      await onChanged();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <section className="card">
      <h2>채널</h2>

      <div className="inject">
        <input
          value={newId}
          placeholder="새 채널 id (영소문자·숫자·하이픈)"
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
          }}
        />
        {/* 라벨이 라우팅 기준이다. Worker가 보는 라벨을 목록으로 주되 직접 입력도 열어둔다 —
            Worker는 나중에 붙을 수도 있으므로 지금 목록에 없다고 막을 일은 아니다. */}
        <input
          className="label-input"
          list="covered-labels"
          value={newLabel}
          placeholder={labelFallback ? `라벨 (기본 ${labelFallback})` : '라벨'}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
          }}
        />
        <datalist id="covered-labels">
          {(coveredLabels ?? []).map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="passthrough">passthrough (LLM 미사용)</option>
          <option value="claude">claude (해석)</option>
        </select>
        <button className="primary" disabled={busy || !newId.trim()} onClick={() => void create()}>
          등록
        </button>
      </div>
      {newId.trim() && willBeOrphan && (
        <p className="warn">
          라벨 <code>{effectiveLabel || newId.trim()}</code>을(를) 보는 Worker가 없습니다.
          이대로 만들면 이 채널의 Task는 <code>pending</code>에서 멈춥니다 —
          Worker의 <code>worker.labels</code>에 추가하거나 위 목록의 라벨을 쓰세요.
        </p>
      )}

      {issuedKey && (
        <div className="issued">
          <strong>{issuedKey.channelId}</strong>의 키를 발급했습니다.{' '}
          <b>지금만 보입니다 — 닫으면 다시 볼 수 없습니다.</b>
          <code className="key">{issuedKey.key}</code>
          <div className="issued-actions">
            <button
              className="small"
              onClick={() => void navigator.clipboard?.writeText(issuedKey.key)}
            >
              복사
            </button>{' '}
            <button className="small" onClick={() => onIssued(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {channels.length === 0 ? (
        <p className="empty">채널이 없습니다.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>라벨</th>
              <th>해석</th>
              <th>키</th>
              <th>출처</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              // 아무도 이 라벨을 안 보면 Task가 만들어져도 pending에 남는다.
              // 등록 시점에 라벨을 안 적으면 id가 라벨이 되므로 쉽게 어긋난다.
              const orphan =
                !c.disabledAt && coveredLabels !== null && !coveredLabels.includes(c.label);
              return (
              <tr key={c.id} className={c.disabledAt ? 'disabled' : ''}>
                <td className="mono">{c.id}</td>
                <td>
                  {c.label}
                  {orphan && (
                    <span
                      className="chip stalled orphan"
                      title={`이 라벨을 보는 Worker가 없습니다. 이 채널로 만들어진 Task는 pending에 남습니다. Worker의 worker.labels에 "${c.label}"을 추가하거나, 이미 처리 중인 라벨로 채널을 다시 등록하세요.`}
                    >
                      Worker 없음
                    </span>
                  )}
                </td>
                <td className="mono">{c.interpreter.mode}</td>
                <td className="mono">{c.maskedKey}</td>
                <td>
                  <span className={`chip ${c.source}`}>{c.source}</span>
                  {c.disabledAt && <span className="chip rejected">비활성</span>}
                </td>
                <td className="actions">
                  {c.source === 'api' && !c.disabledAt && (
                    <>
                      <button className="small" onClick={() => void rotate(c.id)}>
                        키 재발급
                      </button>{' '}
                      <button
                        className="small"
                        title="이벤트 수신만 멈춥니다. 기록은 남습니다."
                        onClick={() => void disable(c.id)}
                      >
                        비활성화
                      </button>{' '}
                    </>
                  )}
                  {c.source === 'api' && (
                    <button
                      className="small danger"
                      title="목록에서 없앱니다. 걸린 기록이 있으면 먼저 알려줍니다."
                      onClick={() => void remove(c.id)}
                    >
                      삭제
                    </button>
                  )}{' '}
                  {!c.disabledAt && (
                    <button
                      className="small"
                      onClick={() => setInjectTo(injectTo === c.id ? null : c.id)}
                    >
                      이벤트 넣기
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {injectTo && (
        <div className="inject">
          <input
            value={payload}
            placeholder={`${injectTo} 채널로 보낼 내용`}
            onChange={(e) => setPayload(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void inject();
            }}
          />
          <button className="primary" disabled={!payload.trim()} onClick={() => void inject()}>
            전송
          </button>
        </div>
      )}

      <p className="hint">
        설정 파일(<code>samdi.server.yaml</code>)에서 온 채널은 파일이 진실이라 여기서 바꿀 수
        없습니다. <b>비활성화</b>는 수신만 멈추고 기록을 남기고, <b>삭제</b>는 목록에서
        없앱니다 — 걸린 Task가 있으면 무엇이 함께 지워지는지 먼저 알려줍니다.
      </p>
    </section>
  );
}
