import { useCallback, useEffect, useState } from 'react';
import type { TaskSummary } from '@samdi/protocol';
import {
  api,
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
                      <td>{t.label}</td>
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
        <p className="empty">지금 일을 물고 있는 Worker가 없습니다.</p>
      ) : (
        <ul className="activity">
          {overview.workers.map((w) => (
            <li key={w.workerId}>
              <span className="mono">{w.workerId}</span>
              <span>{w.inFlight}건 처리 중</span>
              {w.leaseExpiresAt && (
                <span className="detail">lease {timeOf(w.leaseExpiresAt)}까지</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Worker 등록 개념은 아직 없습니다 — 지금 Task를 물고 있는 Worker를 역산해 보여줍니다.
      </p>
    </section>
  );
}

function Channels({
  channels,
  issuedKey,
  onIssued,
  onError,
  onChanged,
}: {
  channels: ChannelRow[];
  issuedKey: { channelId: string; key: string } | null;
  onIssued: (v: { channelId: string; key: string } | null) => void;
  onError: (err: unknown) => void;
  onChanged: () => Promise<void>;
}) {
  const [newId, setNewId] = useState('');
  const [mode, setMode] = useState<'passthrough' | 'claude'>('passthrough');
  const [busy, setBusy] = useState(false);
  const [injectTo, setInjectTo] = useState<string | null>(null);
  const [payload, setPayload] = useState('');

  const create = async () => {
    if (!newId.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.createChannel({ id: newId.trim(), interpreter: { mode } });
      onIssued({ channelId: res.channel.id, key: res.key });
      setNewId('');
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
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="passthrough">passthrough (LLM 미사용)</option>
          <option value="claude">claude (해석)</option>
        </select>
        <button className="primary" disabled={busy || !newId.trim()} onClick={() => void create()}>
          등록
        </button>
      </div>

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
            {channels.map((c) => (
              <tr key={c.id} className={c.disabledAt ? 'disabled' : ''}>
                <td className="mono">{c.id}</td>
                <td>{c.label}</td>
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
                      <button className="small danger" onClick={() => void disable(c.id)}>
                        비활성화
                      </button>{' '}
                    </>
                  )}
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
            ))}
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
        없습니다. 비활성화한 채널은 이벤트를 받지 않지만, 이미 만들어진 Task가 참조하므로 목록에는
        남습니다.
      </p>
    </section>
  );
}
