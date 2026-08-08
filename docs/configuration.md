# 설정 레퍼런스

samdi의 설정 파일(YAML) 전체 키, 환경변수 매핑, 자주 하는 변경 작업을 담았다.
사람과 코딩 에이전트 모두 이 문서 하나로 설정을 바꿀 수 있게 쓰였다.

**스키마 원본은 [`packages/config/src/schema.ts`](../packages/config/src/schema.ts)다.**
이 문서와 스키마가 어긋나면 스키마가 옳다. 키를 추가·변경하면 이 문서도 같이 고친다(마지막 절 체크리스트 참조).

---

## 1. 원칙

- **설정 파일은 없어도 된다.** 모든 키에 기본값이 있어서, 파일 없이 실행하면 로컬 데모 구성으로 돈다.
- **적용 우선순위: 환경변수 > 설정 파일 > 기본값.** 환경변수는 항상 파일을 덮는다.
- **파일은 두 개로 분리된다.** Control Plane(서버)과 Worker(사용자 기기)는 다른 머신에서 돌 수 있다.
- **모든 값은 시작 시 zod로 검증된다.** 틀린 값은 조용히 무시되지 않고 키 이름과 함께 오류로 죽는다.

## 2. 파일 위치와 탐색 순서

먼저 발견된 하나만 읽는다(여러 파일을 병합하지 않는다).

**Control Plane**

1. `SAMDI_SERVER_CONFIG` 환경변수의 경로 — **지정했는데 파일이 없으면 오류로 종료한다**(오타를 조용히 넘기지 않기 위해)
2. `./samdi.server.yaml`
3. `~/.samdi/server.yaml`
4. 없으면 기본값

**Worker**

1. `SAMDI_WORKER_CONFIG` 환경변수의 경로 — 없으면 오류로 종료
2. `./samdi.worker.yaml`
3. `~/.samdi/worker.yaml`
4. 없으면 기본값

> **주의: `./`는 프로세스의 작업 디렉토리다.** `pnpm --filter @samdi/control-plane start`로 실행하면 cwd가
> `apps/control-plane/`이므로 `./samdi.server.yaml`은 `apps/control-plane/samdi.server.yaml`을 뜻한다.
> 리포 루트에 두고 쓰려면 `SAMDI_SERVER_CONFIG=$PWD/samdi.server.yaml`처럼 절대 경로로 지정하거나
> `~/.samdi/`에 두는 편이 헷갈리지 않는다. 같은 이유로 `dbPath` 기본값(`samdi.sqlite`)도
> `apps/control-plane/samdi.sqlite`에 만들어진다.

시작 로그에 어떤 파일을 읽었는지 찍힌다(`config: /경로` 또는 `config: (기본값)`). 설정이 안 먹는 것 같으면 여기부터 본다.

경로 값에 쓴 `~`는 홈 디렉토리로 펼쳐진다(`~/.samdi/agent-workspace` → `/Users/you/.samdi/agent-workspace`).

예시 파일: [`samdi.server.example.yaml`](../samdi.server.example.yaml), [`samdi.worker.example.yaml`](../samdi.worker.example.yaml)

## 3. Control Plane 키 (`samdi.server.yaml`)

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `port` | 정수 1–65535 | `3000` | HTTP 포트 |
| `host` | 문자열 | `127.0.0.1` | 바인드 주소. 외부 웹훅을 받으려면 `0.0.0.0` |
| `dbPath` | 경로 | `samdi.sqlite` | SQLite 파일. Task 상태·본문·감사 로그가 모두 여기 |
| `workerKey` | 문자열 | `demo-worker-key` | Worker가 claim/보고에 쓰는 공용 키. Worker 쪽 `controlPlane.workerKey`와 **같아야 한다** |
| `sweepIntervalMs` | 양의 정수 | `30000` | lease 만료 스캔 주기. 만료된 Task를 `stalled`로 옮긴다 |
| `channels` | 채널 배열 | 아래 참조 | 웹훅을 받을 채널. 시작할 때 DB로 동기화(upsert)된다 |

`channels[]` 항목:

| 키 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | 문자열 | 필수 | 웹훅 URL에 들어간다: `POST /channels/<id>/events` |
| `key` | 문자열 | 필수 | 웹훅 인증 키. 요청 헤더 `x-channel-key`와 비교한다 |
| `label` | 문자열 | 선택 | 라우팅 기준. 생략하면 `id`를 라벨로 쓴다. **Worker의 `worker.labels`에 이 값이 있어야 Task를 claim한다** |

`channels` 기본값:

```yaml
channels:
  - id: demo
    label: demo
    key: demo-channel-key
```

동기화는 upsert다 — 설정에서 지운 채널이 DB에서 삭제되지는 않는다(기존 Task의 외래키를 지키기 위해).

## 4. Worker 키 (`samdi.worker.yaml`)

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `controlPlane.url` | URL | `http://127.0.0.1:3000` | Control Plane 주소 |
| `controlPlane.workerKey` | 문자열 | `demo-worker-key` | 서버의 `workerKey`와 같아야 한다 |
| `controlPlane.channelKey` | 문자열 | `demo-channel-key` | **데모 이벤트 주입에만** 쓰인다(UI의 "이벤트 주입", demo-cli). 실제 웹훅 경로와는 무관 |
| `worker.id` | 문자열 | `worker-1` | claim 주체 식별자. 감사 로그에 남는다 |
| `worker.labels` | 문자열 배열 | `[demo]` | 이 Worker가 claim할 라벨 목록. 채널의 `label`과 맞아야 한다 |
| `worker.pollIntervalMs` | 양의 정수 | `2000` | claim 폴링 주기 |
| `worker.leaseSeconds` | 1–3600 | `600` | lease 길이. 이 시간 안에 보고가 없으면 서버가 `stalled`로 옮긴다 |
| `worker.reportPort` | 정수 1–65535 | `4700` | 로컬 보고 API + UI용 API 포트(루프백 전용) |
| `defaultAgent` | `mock` \| `claude-code` \| `claude-code-terminal` | `mock` | Task에 `agent` 지정이 없을 때 쓸 에이전트 |
| `agents.claude-code` | 객체 | 아래 표 | headless 실행 어댑터 설정 |
| `agents.claude-code-terminal` | 객체 | 아래 표 | Terminal 창 실행 어댑터 설정(macOS 전용) |

`agents.*` 공통 키:

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `bin` | 문자열 | (없음 → PATH의 `claude`) | claude 실행 파일 경로 |
| `allowedTools` | 문자열 | `Bash(curl *)` | Claude Code `--allowedTools` 값. **보고용 curl이 빠지면 완료 보고를 못 한다** |
| `permissionMode` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions` | (없음) | Claude Code `--permission-mode` |
| `cwd` | 경로 | (없음 → `~/.samdi/agent-workspace`) | 에이전트 작업 디렉토리. **고정 경로여야** Claude Code의 폴더 신뢰 수락이 재사용된다 |
| `timeoutMs` | 양의 정수 | `600000` | headless 실행 타임아웃. `claude-code-terminal`은 무시한다 |

> `worker.reportPort`를 바꾸면 worker-ui의 프록시도 같은 포트를 봐야 한다.
> UI를 띄울 때 `SAMDI_REPORT_PORT`를 같이 주면 된다(4절 레시피 참조).

## 5. 환경변수 매핑

환경변수는 항상 설정 파일을 덮는다. 값 형식은 파일과 동일하게 검증된다(숫자 자리에 `abc`를 주면 오류).

**Control Plane**

| 환경변수 | 대응 키 |
| --- | --- |
| `SAMDI_SERVER_CONFIG` | (설정 파일 경로 지정) |
| `PORT` | `port` |
| `SAMDI_HOST` | `host` |
| `SAMDI_DB_PATH` | `dbPath` |
| `SAMDI_WORKER_KEY` | `workerKey` |
| `SAMDI_SWEEP_INTERVAL_MS` | `sweepIntervalMs` |
| `SAMDI_CHANNEL_KEY` | `channels` 중 **id가 `demo`인 항목의 `key`만** 덮는다(데모 편의). 해당 채널이 없으면 아무 일도 없다 |

**Worker**

| 환경변수 | 대응 키 |
| --- | --- |
| `SAMDI_WORKER_CONFIG` | (설정 파일 경로 지정) |
| `SAMDI_CONTROL_PLANE_URL` | `controlPlane.url` |
| `SAMDI_WORKER_KEY` | `controlPlane.workerKey` |
| `SAMDI_CHANNEL_KEY` | `controlPlane.channelKey` |
| `SAMDI_WORKER_ID` | `worker.id` |
| `SAMDI_LABELS` | `worker.labels` — 콤마 구분(`mail,ops`) |
| `SAMDI_POLL_INTERVAL_MS` | `worker.pollIntervalMs` |
| `SAMDI_LEASE_SECONDS` | `worker.leaseSeconds` |
| `SAMDI_REPORT_PORT` | `worker.reportPort` |
| `SAMDI_AGENT` | `defaultAgent` |
| `SAMDI_CLAUDE_BIN` | `agents.claude-code.bin`, `agents.claude-code-terminal.bin` |
| `SAMDI_CLAUDE_ALLOWED_TOOLS` | 두 어댑터의 `allowedTools` |
| `SAMDI_CLAUDE_PERMISSION_MODE` | 두 어댑터의 `permissionMode` |
| `SAMDI_CLAUDE_CWD` | 두 어댑터의 `cwd` |
| `SAMDI_CLAUDE_TIMEOUT_MS` | 두 어댑터의 `timeoutMs` |

`SAMDI_CLAUDE_*`는 **두 claude 어댑터에 함께** 적용된다. 하나만 다르게 하려면 설정 파일을 쓴다.

## 6. 작업 레시피

### 기본 에이전트를 실제 Claude Code로 바꾼다

`samdi.worker.yaml`:

```yaml
defaultAgent: claude-code
agents:
  claude-code:
    cwd: ~/.samdi/agent-workspace
```

한 번만 시험할 때는 `SAMDI_AGENT=claude-code pnpm --filter @samdi/worker start`로 충분하다.
Task별로는 UI의 이벤트 주입 폼에서 에이전트를 골라도 되며, 그 지정이 `defaultAgent`보다 우선한다.

### 에이전트가 실제로 파일을 만들고 명령을 실행하게 한다

기본값은 보고용 curl만 허용한다. 작업 도구를 열어줘야 한다:

```yaml
agents:
  claude-code:
    allowedTools: Bash(curl *),Read,Write,Edit,Bash
    permissionMode: acceptEdits
```

`allowedTools`에서 `Bash(curl *)`를 빼지 않는다 — 빠지면 완료 보고가 막혀 Task가 `stalled`로 흘러간다.

### 새 채널(웹훅 수신구)을 추가한다

`samdi.server.yaml`의 `channels`에 항목을 넣고 Control Plane을 재시작한다:

```yaml
channels:
  - id: demo
    label: demo
    key: demo-channel-key
  - id: mail
    label: inbox
    key: 충분히-긴-임의-문자열
```

Worker가 그 라벨을 claim하도록 `samdi.worker.yaml`도 맞춘다:

```yaml
worker:
  labels: [demo, inbox]
```

이벤트 전송:

```sh
curl -X POST http://127.0.0.1:3000/channels/mail/events \
  -H 'content-type: application/json' \
  -H 'x-channel-key: 충분히-긴-임의-문자열' \
  -d '{"payload":"자연어 본문"}'
```

### Task가 pending에서 안 움직인다

`worker.labels`에 채널의 `label`이 없는 경우가 대부분이다. 라벨은 `label`이 지정돼 있으면 그 값, 없으면 채널 `id`다.
서버·Worker의 `workerKey`가 어긋났는지도 확인한다(어긋나면 Worker 로그에 401이 남는다).

### UI에서 드롭다운을 조작할 시간이 없다

`worker.pollIntervalMs`를 늘리면 pending 창이 길어진다(예: `15000`). 상시 지정은 주입 시점에 고르는 편이 확실하다.

### 포트를 바꾼다

```yaml
# samdi.worker.yaml
worker:
  reportPort: 4800
```

UI 프록시도 같은 포트를 봐야 한다:

```sh
SAMDI_REPORT_PORT=4800 pnpm --filter @samdi/worker-ui dev
```

### 서버 상태를 초기화한다

`dbPath` 파일(기본 `apps/control-plane/samdi.sqlite`)과 `-wal`, `-shm` 파일을 지우고 재시작한다.
채널은 설정에서 다시 동기화되므로 따로 만들 필요가 없다.

## 7. 오류 메시지 해석

시작 시 설정이 잘못되면 프로세스가 종료 코드 1로 죽고, 메시지가 원인과 키를 가리킨다.

| 메시지 | 원인 | 조치 |
| --- | --- | --- |
| `설정 파일이 없다: /경로` | `SAMDI_*_CONFIG`가 가리키는 파일이 없다 | 경로 오타 확인 |
| `YAML 문법 오류: /경로` | 들여쓰기·괄호 문제 | 해당 줄 수정 |
| `설정 파일의 최상위는 매핑(key: value)이어야 한다` | 최상위가 리스트/스칼라 | `key: value` 형태로 |
| `... 올바르지 않다:` + `- worker.leaseSeconds: ...` | 값이 스키마 위반 | 표시된 키를 4·5절 표와 맞춘다 |
| `- defaultAgent: Invalid enum value...` | 없는 에이전트 이름 | `mock`, `claude-code`, `claude-code-terminal` 중 하나 |

## 8. 키를 추가·변경할 때 (개발자·에이전트용 체크리스트)

1. [`packages/config/src/schema.ts`](../packages/config/src/schema.ts)에 키를 추가한다. **반드시 기본값을 준다**(파일 없이도 돌아야 한다).
2. 환경변수로도 덮게 하려면 [`packages/config/src/load.ts`](../packages/config/src/load.ts)의 `overrides` 객체에 매핑을 추가한다.
3. 값을 쓰는 곳(`apps/control-plane/src/index.ts` 또는 `apps/worker/src/index.ts`)에서 설정을 읽어 전달한다.
4. [`packages/config/src/load.test.ts`](../packages/config/src/load.test.ts)에 기본값·파일·env 오버라이드 케이스를 추가한다.
5. **이 문서의 표**(3·4·5절)와 예시 YAML 두 개를 갱신한다.
6. `pnpm typecheck && pnpm test`로 확인한다.
