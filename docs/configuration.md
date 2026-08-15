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
| `workerKey` | 문자열 | `demo-worker-key` | Worker가 claim/보고에 쓰는 키. Worker 쪽 `controlPlane.workerKey`와 **같아야 한다** |
| `adminKey` | 문자열 | `demo-admin-key` | 관리 화면이 쓰는 키. 전체 조회와 채널 등록·키 발급 권한 |
| `sweepIntervalMs` | 양의 정수 | `30000` | lease 만료 스캔 주기. 만료된 Task를 `stalled`로 옮긴다 |
| `uiDist` | 경로 | (없음) | 빌드된 관리 화면(`apps/control-plane-ui/dist`) 경로. 주면 서버가 `/`로 서빙한다. 개발 중에는 vite 개발 서버를 쓰므로 비워둔다 |
| `channels` | 채널 배열 | 아래 참조 | 웹훅을 받을 채널. 시작할 때 DB로 동기화(upsert)된다 |

**키가 셋인 이유는 권한 범위가 셋이기 때문이다.**

| 키 | 헤더 | 할 수 있는 일 |
| --- | --- | --- |
| 채널 키 | `x-channel-key` | 그 채널로 이벤트를 넣는 것만 |
| `workerKey` | `x-worker-key` | claim·보고·복구, 그리고 Task 조회 |
| `adminKey` | `x-admin-key` | Task 조회 + 전체 현황 + 채널 등록·키 발급·비활성화 |

Worker 하나가 뚫려도 채널을 만들거나 남의 Task를 훑을 수 없어야 하므로 뒤 둘을 나눈다.
Task 조회(`GET /tasks`, `GET /tasks/:id`)는 둘 다 정당해서 어느 키로든 통한다.

`channels[]` 항목:

| 키 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | 문자열 | 필수 | 웹훅 URL에 들어간다: `POST /channels/<id>/events` |
| `key` | 문자열 | 필수 | 웹훅 인증 키. 요청 헤더 `x-channel-key`와 비교한다 |
| `label` | 문자열 | 선택 | 라우팅 기준. 생략하면 `id`를 라벨로 쓴다. **Worker의 `worker.labels`에 이 값이 있어야 Task를 claim한다** |
| `interpreter` | 객체 | 선택 | 이 채널의 해석 방식. 생략하면 `passthrough`(LLM 미사용) |

**채널의 진실은 DB다.** 설정 파일에 적은 채널은 시작할 때마다 파일 내용으로 덮어써지고,
관리 화면(`POST /admin/channels`)에서 만든 채널은 DB에만 있다. 그래서
**파일에서 온 채널은 관리 화면에서 고칠 수 없다** — 고쳐봐야 다음 시작에 되돌아가기 때문이다.
바꾸려면 파일을 고친다.

채널을 지우는 API는 실제로 지우지 않고 **비활성화**한다. Task와 문맥 스레드가 채널을
참조하는 감사 기록이라, 지우면 "이 Task가 어디서 왔는가"를 잃는다. 비활성화된 채널은
이벤트를 받지 않지만 목록에는 남고, 같은 id로 다시 등록하면 새 키로 되살아난다.

`channels` 기본값:

```yaml
channels:
  - id: demo
    label: demo
    key: demo-channel-key
    interpreter:
      mode: passthrough
```

### `channels[].interpreter` — 해석 설정

**`mode`가 이 채널을 어떤 해석기로 처리할지 정한다.**

| 모드 | 동작 |
| --- | --- |
| `passthrough` (기본값) | LLM을 전혀 쓰지 않는다. 이벤트 하나가 곧 Task 하나가 되고, 라벨은 채널의 `label`을 그대로 쓴다. 문맥 스레드를 만들지 않으므로 `ttlSeconds`·`debounceMs`·`labels`는 무시된다 |
| `claude` | 내장 Anthropic 구현. 이벤트를 문맥 스레드에 쌓고, 잠잠해지면 판정한다: `fast_pass`(즉시 분배) / `complete`(문맥 완성 → 분배) / `needs_context`(더 기다림) / `noise`(폐기) |
| `http` | 판정을 설정한 주소에 위임한다. 그 뒤에 무엇을 두든 상관없다 — 로컬 모델, 다른 프로바이더, 직접 만든 규칙 |

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `mode` | `passthrough` \| `claude` \| `http` | `passthrough` | 위 표 참조 |
| `ttlSeconds` | 양의 정수 | `3600` | 이 시간 동안 새 이벤트가 없으면 스레드를 `expired`로 닫는다 |
| `debounceMs` | 0 이상 정수 | `2000` | 이벤트가 붙은 뒤 이만큼 잠잠해야 해석기를 돌린다. 연속 유입 시 호출 낭비를 막는다 |
| `labels` | 문자열 배열 | `[]` | 해석기가 고를 수 있는 라벨의 닫힌 집합. 비우면 채널 `label` 하나만 쓴다. **여기 있는 라벨은 Worker의 `worker.labels`에도 있어야 claim된다** |
| `guidance` | 문자열 | (없음) | 기본 프롬프트 **뒤에 덧붙일** 채널별 맥락. 프롬프트 조정은 보통 이걸로 충분하다 |
| `systemPrompt` | 문자열 | (내장 기본값) | 기본 프롬프트를 **통째로 대체**한다. 판정 4종의 의미는 파이프라인이 의존하는 계약이므로 대체하더라도 그대로 설명해야 한다 |
| `claude.model` | 문자열 | `claude-opus-5` | `mode: claude`일 때 쓸 모델 |
| `claude.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `low` | 분류는 가벼운 작업이라 낮은 값으로 충분하다 |
| `http.url` | URL | (필수) | `mode: http`일 때 판정을 POST할 주소. 없으면 시작 시 오류 |
| `http.headers` | 문자열 맵 | `{}` | 인증 헤더 등 |
| `http.timeoutMs` | 양의 정수 | `30000` | 응답 대기 한도 |

**`mode: claude`는 자격 증명이 필요하다.** Control Plane 프로세스가 `ANTHROPIC_API_KEY`(또는 `ant auth login` 프로필)를 읽을 수 있어야 한다.
자격 증명이 없으면 해석이 실패하고, 그 스레드는 판정 없이 열린 채 남아 다음 스캔마다 재시도되다가 TTL로 닫힌다 —
Task가 잘못 만들어지지는 않지만 아무 일도 진행되지 않으므로, 로그에 `interpreter failed`가 반복되면 자격 증명부터 확인한다.

#### `mode: http` 규약

samdi가 보내는 요청:

```json
{
  "systemPrompt": "…(guidance까지 합쳐진 최종 프롬프트)…",
  "channelId": "mail",
  "labels": ["inbox", "coding"],
  "events": [{ "at": "2026-01-01T00:00:00.000Z", "payload": "로그인이 안 돼요" }]
}
```

기대하는 응답 — 판정 하나:

```json
{ "verdict": "fast_pass", "label": "coding", "instruction": "로그인 버그를 고쳐라" }
{ "verdict": "complete",  "label": "coding", "instruction": "…" }
{ "verdict": "needs_context", "reason": "…" }
{ "verdict": "noise",         "reason": "…" }
```

응답이 이 규약과 다르면 판정을 지어내지 않고 `needs_context`로 둔다. HTTP 오류(비 2xx)는 실패로 보고 다음 스캔에서 재시도한다.
`label`이 카탈로그 밖이면 첫 라벨로 되돌린다.

#### 내장 구현 말고 다른 걸 쓰려면

해석기는 인터페이스다. `@samdi/interpreter`의 `Interpreter`(메서드 하나: `interpret(input)`)만 만족시키고
`createInterpreter(config, { 모드이름: () => new 내구현() })`으로 넘기면 된다 — 패키지를 고칠 필요가 없다.
`mode: http`는 코드를 전혀 건드리지 않는 버전의 같은 탈출구다.

**문맥 키.** 같은 스레드로 묶으려면 이벤트를 보낼 때 `contextKey`를 함께 넣는다(메일 체인 ID, Slack `thread_ts`, 이슈 번호 등).
생략하면 이벤트마다 새 스레드가 열린다 — 문맥 축적 없이 이벤트 하나씩 해석된다.

동기화는 upsert다 — 설정에서 지운 채널이 DB에서 삭제되지는 않는다(기존 Task의 외래키를 지키기 위해).

## 4. Worker 키 (`samdi.worker.yaml`)

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `controlPlane.url` | URL | `http://127.0.0.1:3000` | Control Plane 주소 |
| `controlPlane.workerKey` | 문자열 | `demo-worker-key` | 서버의 `workerKey`와 같아야 한다 |
| `worker.id` | 문자열 | `worker-1` | claim 주체 식별자. 감사 로그에 남는다 |
| `worker.labels` | 문자열 배열 | `[demo]` | 이 Worker가 claim할 라벨 목록. 채널의 `label`과 맞아야 한다 |
| `worker.pollIntervalMs` | 양의 정수 | `2000` | claim 폴링 주기 |
| `worker.leaseSeconds` | 1–3600 | `600` | lease 길이. 이 시간 안에 보고가 없으면 서버가 `stalled`로 옮긴다 |
| `worker.reportPort` | 정수 1–65535 | `4700` | 로컬 보고 API + UI용 API 포트 |
| `worker.reportHost` | 문자열 | `127.0.0.1` | 보고 API를 바인드할 주소. **기본값에서 바꾸지 않는 게 맞다** — 보고 API에는 인증이 없어서, 열면 아무나 완료를 위조하고 승인 질문에 답할 수 있다. 컨테이너에서만 `0.0.0.0`으로 두고 노출은 호스트의 `-p 127.0.0.1:...`이 막는다([Docker 문서](docker.md)) |
| `worker.concurrency` | 1–32 | `1` | 동시에 처리할 Task 수. 1이면 앞선 Task가 끝나야 다음을 집는다 — 사람을 기다리는 작업이 있으면 그 뒤가 전부 밀린다 |
| `uiDist` | 경로 | (없음) | 빌드된 대시보드(`apps/worker-ui/dist`) 경로. 주면 Worker가 `/`로 직접 서빙한다. 개발 중에는 vite 개발 서버를 쓰므로 비워둔다 |
| `startGate.requireApproval` | 불리언 | `true` | 시작 전 사람 승인을 받는다. 에이전트 종류와 무관하게 Worker가 강제한다 |
| `startGate.autoPassLabels` | 문자열 배열 | `[]` | 승인 없이 통과시킬 라벨 |
| `startGate.autoPassChannels` | 문자열 배열 | `[]` | 승인 없이 통과시킬 채널 |
| `defaultAgent` | `mock` \| `claude-code` | `mock` | Task에 `agent` 지정이 없을 때 쓸 에이전트 |
| `agents.claude-code` | 객체 | 아래 표 | Claude Code 어댑터 설정. Terminal 창을 띄워 진행 과정을 보며 개입할 수 있다(macOS 전용) |

`agents.*` 공통 키:

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `bin` | 문자열 | (없음 → PATH의 `claude`) | claude 실행 파일 경로 |
| `allowedTools` | 문자열 | `Bash(curl *)` | Claude Code `--allowedTools` 값. **보고용 curl이 빠지면 완료 보고를 못 한다** |
| `permissionMode` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions` | (없음) | Claude Code `--permission-mode` |
| `cwd` | 경로 | (없음 → `~/.samdi/agent-workspace`) | 에이전트 작업 디렉토리. **고정 경로여야** Claude Code의 폴더 신뢰 수락이 재사용된다 |

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
| `SAMDI_ADMIN_KEY` | `adminKey` |
| `SAMDI_SWEEP_INTERVAL_MS` | `sweepIntervalMs` |
| `SAMDI_UI_DIST` | `uiDist` (관리 화면 dist) |
| `SAMDI_CHANNEL_KEY` | `channels` 중 **id가 `demo`인 항목의 `key`만** 덮는다(데모 편의). 해당 채널이 없으면 아무 일도 없다 |

**Worker**

| 환경변수 | 대응 키 |
| --- | --- |
| `SAMDI_WORKER_CONFIG` | (설정 파일 경로 지정) |
| `SAMDI_CONTROL_PLANE_URL` | `controlPlane.url` |
| `SAMDI_WORKER_KEY` | `controlPlane.workerKey` |
| `SAMDI_WORKER_ID` | `worker.id` |
| `SAMDI_LABELS` | `worker.labels` — 콤마 구분(`mail,ops`) |
| `SAMDI_POLL_INTERVAL_MS` | `worker.pollIntervalMs` |
| `SAMDI_LEASE_SECONDS` | `worker.leaseSeconds` |
| `SAMDI_REPORT_PORT` | `worker.reportPort` |
| `SAMDI_REPORT_HOST` | `worker.reportHost` |
| `SAMDI_CONCURRENCY` | `worker.concurrency` |
| `SAMDI_UI_DIST` | `uiDist` |
| `SAMDI_REQUIRE_APPROVAL` | `startGate.requireApproval` (`false`면 끔) |
| `SAMDI_AGENT` | `defaultAgent` |
| `SAMDI_CLAUDE_BIN` | `agents.claude-code.bin` |
| `SAMDI_CLAUDE_ALLOWED_TOOLS` | `agents.claude-code.allowedTools` |
| `SAMDI_CLAUDE_PERMISSION_MODE` | `agents.claude-code.permissionMode` |
| `SAMDI_CLAUDE_CWD` | `agents.claude-code.cwd` |

`SAMDI_REQUIRE_APPROVAL=false`로 승인 정책을 끌 수 있고, `SAMDI_CONCURRENCY`로 동시 처리 수를 바꾼다.

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

### LLM 해석을 켠다 (또는 끈다)

기본값은 꺼짐이다. 켜려면 채널에 `interpreter.mode`를 준다:

```yaml
channels:
  - id: mail
    label: inbox
    key: 충분히-긴-임의-문자열
    interpreter:
      mode: claude
      labels: [inbox, coding]
      ttlSeconds: 1800
```

Control Plane을 재시작하고, 그 프로세스에 `ANTHROPIC_API_KEY`가 보이는지 확인한다.
Worker의 `worker.labels`에 `labels`의 값이 모두 들어 있어야 분배된 Task를 claim한다.

되돌리려면 `mode: passthrough`로 바꾸거나 `interpreter` 블록을 지운다 — LLM 호출이 완전히 사라진다.

### 해석 프롬프트를 채널에 맞게 조정한다

대부분은 `guidance`로 충분하다 — 기본 프롬프트 뒤에 이 채널의 맥락만 덧붙인다:

```yaml
interpreter:
  mode: claude
  labels: [inbox, coding, ops]
  guidance: |
    이 채널은 고객 지원 메일함이다.
    - 버그 신고는 coding, 요금·계약 문의는 ops로 분류한다.
    - 마케팅 메일과 자동 발송 영수증은 noise다.
    - 첫 메일이 증상만 말하고 재현 조건이 없으면 needs_context로 두고 후속 메일을 기다린다.
```

판정 체계 자체를 다시 쓰고 싶으면 `systemPrompt`로 통째로 대체한다. 단, `fast_pass` / `needs_context` /
`complete` / `noise` 네 판정의 의미는 파이프라인이 의존하는 계약이므로 새 프롬프트에도 그대로 설명해야 한다.
기본 프롬프트 원문은 [`packages/interpreter/src/claude.ts`](../packages/interpreter/src/claude.ts)의
`DEFAULT_INTERPRETER_PROMPT`에 있다 — 거기서 복사해 고쳐 쓰는 걸 권한다.

### 다른 LLM을 쓴다

`mode: http`로 판정을 바깥에 위임한다. samdi는 그 주소 뒤에 무엇이 있는지 신경 쓰지 않는다:

```yaml
interpreter:
  mode: http
  labels: [inbox, coding]
  guidance: |
    이 채널은 고객 지원 메일함이다.
  http:
    url: http://127.0.0.1:11434/interpret
    headers:
      Authorization: Bearer 토큰
    timeoutMs: 30000
```

그 주소는 요청의 `systemPrompt`·`labels`·`events`를 받아 판정 JSON을 돌려주면 된다(위 [규약](#mode-http-규약) 참조).
로컬 모델을 붙이든, 다른 프로바이더 SDK를 얇게 감싸든, 규칙 기반으로 처리하든 samdi 코드는 그대로다.

### 여러 이벤트를 한 작업으로 묶는다

llm 모드 채널에 이벤트를 보낼 때 `contextKey`를 같이 넣으면 같은 스레드에 쌓인다:

```sh
curl -X POST http://127.0.0.1:3000/channels/mail/events \
  -H 'content-type: application/json' -H 'x-channel-key: <키>' \
  -d '{"payload":"로그인이 안 돼요","contextKey":"thread-42"}'
```

응답의 `taskId`는 `null`, `threadId`가 채워져 온다 — 아직 Task가 아니라 축적 중이라는 뜻이다.
스레드 상태는 `GET /channels/<id>/threads`, 개별 스레드는 `GET /threads/<threadId>`로 본다(워커 키 필요).

### 새 채널(웹훅 수신구)을 추가한다

두 가지 방법이 있고, 고르는 기준은 **"이 채널이 배포에 속하는가"** 다.

**① 관리 화면에서 등록** — 재시작이 필요 없고 키가 자동 발급된다. 운영 중에 채널을
늘리는 보통의 경우다.

관리 화면(기본 <http://localhost:5174>)의 **채널** 카드에서 id를 넣고 등록하면
키가 한 번 표시된다. **그 자리에서 복사해야 한다** — 이후에는 가려진 형태만 보인다.
잃어버렸으면 "키 재발급"을 누른다(예전 키는 즉시 막힌다).

API로도 같다:

```sh
curl -X POST http://127.0.0.1:3000/admin/channels \
  -H 'content-type: application/json' -H 'x-admin-key: <관리 키>' \
  -d '{"id":"mail","label":"inbox","interpreter":{"mode":"claude"}}'
# → {"channel":{...},"key":"ch_..."}   ← 평문 키는 여기서만 나온다
```

**② 설정 파일에 적기** — 배포에 속한 채널, 즉 "이 서버라면 항상 있어야 하는" 채널일 때.
파일이 진실이므로 시작할 때마다 파일 내용으로 덮어써지고, **관리 화면에서 고칠 수 없다.**

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

### 승인을 면제할 채널·라벨을 정한다

기본값은 **모든 Task가 시작 전 승인을 받는다**. 이건 Worker의 Start Gate가 강제하므로
에이전트가 무엇이든(mock이든 Claude Code든) 똑같이 동작한다. 면제할 것만 나열한다:

```yaml
# samdi.worker.yaml
startGate:
  requireApproval: true
  autoPassLabels: [reports]      # 이 라벨은 바로 실행
  autoPassChannels: [cron]       # 이 채널도 바로 실행
```

전부 승인 없이 돌리려면 `requireApproval: false` (또는 `SAMDI_REQUIRE_APPROVAL=false`).

### 앞선 작업이 끝나야 다음이 시작된다

기본 `worker.concurrency`가 1이라 그렇다. Terminal 에이전트처럼 사람을 기다리는 작업이
있으면 그 뒤가 전부 `pending`에 밀린다. 동시에 여러 건을 처리하려면 올린다:

```yaml
worker:
  concurrency: 3
```

claim은 서버에서 원자적이므로 같은 Task를 둘이 집는 일은 없다.

### 승인 버튼이 안 뜬다 (Task는 `waiting`인데)

승인 대기는 Worker의 메모리에 있다. Worker가 재시작하면(개발 중 파일 저장 → `tsx watch`,
크래시, 수동 재시작) 에이전트 프로세스와 함께 그 대기 정보도 사라진다.

Worker는 시작할 때 이전 실행이 물고 있던 Task를 **`stalled`로 되돌린다** — 그러면 목록에
재시도/포기 버튼이 뜬다. 재시도하면 처음부터 다시 처리되고 승인도 다시 요청된다.
로그에 `previous run left tasks in flight; moved to stalled for manual retry`가 남는다.

> `worker.id`가 겹치면 서로의 Task를 되돌린다. Worker를 여러 대 띄운다면 **id를 다르게** 준다.

### 완료된 Task가 UI 목록에서 사라졌다

의도된 동작이다. UI는 1.5초마다 목록을 폴링하므로 종결된 Task(`completed`·`failed`·`rejected`)는
싣지 않는다. 끝난 것까지 보려면:

```sh
curl "http://127.0.0.1:3000/tasks?view=all&limit=100" -H 'x-worker-key: demo-worker-key'
cd apps/demo-cli && pnpm start list          # CLI는 기본이 전체
```

전용 조회 화면은 로드맵의 "관찰성·운영" 항목에 있다.

### Task가 pending에서 안 움직인다

`worker.labels`에 채널의 `label`이 없는 경우가 대부분이다. 라벨은 `label`이 지정돼 있으면 그 값, 없으면 채널 `id`다.
서버·Worker의 `workerKey`가 어긋났는지도 확인한다(어긋나면 Worker 로그에 401이 남는다).

### UI에서 드롭다운을 조작할 시간이 없다

`worker.pollIntervalMs`를 늘리면 pending 창이 길어진다(예: `15000`). 상시 지정은 주입 시점에 고르는 편이 확실하다.

### 포트를 바꾼다

`pnpm dev`로 한 번에 띄운다면 환경변수 셋이면 된다 — 스크립트가 세 프로세스에 맞춰 넘긴다:

```sh
PORT=3001 SAMDI_REPORT_PORT=4801 UI_PORT=5174 pnpm dev
```

설정 파일에 고정하려면 서버는 `port`, Worker는 `worker.reportPort`를 쓴다:

```yaml
# samdi.worker.yaml
worker:
  reportPort: 4800
```

이때 UI를 따로 띄운다면 프록시가 같은 포트를 봐야 한다
(`vite.config.ts`가 `SAMDI_REPORT_PORT`를, UI 자신의 포트는 `UI_PORT`를 읽는다):

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
| `- defaultAgent: Invalid enum value...` | 없는 에이전트 이름 | `mock` 또는 `claude-code` |

## 8. 키를 추가·변경할 때 (개발자·에이전트용 체크리스트)

1. [`packages/config/src/schema.ts`](../packages/config/src/schema.ts)에 키를 추가한다. **반드시 기본값을 준다**(파일 없이도 돌아야 한다).
2. 환경변수로도 덮게 하려면 [`packages/config/src/load.ts`](../packages/config/src/load.ts)의 `overrides` 객체에 매핑을 추가한다.
3. 값을 쓰는 곳(`apps/control-plane/src/index.ts` 또는 `apps/worker/src/index.ts`)에서 설정을 읽어 전달한다.
4. [`packages/config/src/load.test.ts`](../packages/config/src/load.test.ts)에 기본값·파일·env 오버라이드 케이스를 추가한다.
5. **이 문서의 표**(3·4·5절)와 예시 YAML 두 개를 갱신한다.
6. `pnpm typecheck && pnpm test`로 확인한다.
