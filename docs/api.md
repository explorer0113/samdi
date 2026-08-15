# API 예시

HTTP API 전부와 실행 가능한 `curl` 예시. 아래 예시는 전부 `pnpm dev`로 띄운
기본 설정(데모 키)에 대고 검증한 것이다.

**API가 둘인 이유는 평면이 둘이기 때문이다.**

| | 주소 | 누가 부르나 |
| --- | --- | --- |
| Control Plane API | `http://127.0.0.1:3000` | 채널(웹훅), Worker, 관리 화면 |
| Worker 로컬 API | `http://127.0.0.1:4700` | 에이전트, Worker UI. **루프백 전용** |

## 인증

**키마다 할 수 있는 일이 다르다.** Worker 하나가 뚫려도 채널을 만들거나
전체를 훑을 수 없어야 하기 때문이다.

| 키 | 헤더 | 할 수 있는 일 |
| --- | --- | --- |
| 채널 키 | `x-channel-key` | 그 채널로 이벤트 넣기 |
| Worker 키 | `x-worker-key` | claim·보고·복구 + Task 조회 |
| 관리 키 | `x-admin-key` | Task 조회 + 전체 현황 + 채널 등록·키 발급 |

Worker 로컬 API에는 인증이 없다 — 루프백에만 바인딩된다는 것이 그 자리를 대신한다
([docs/docker.md](docker.md#포트를-열-때-주의할-것)).

아래 예시는 이 변수를 쓴다:

```sh
CP=http://127.0.0.1:3000
WORKER=http://127.0.0.1:4700
ADMIN='x-admin-key: demo-admin-key'
WK='x-worker-key: demo-worker-key'
JSON='content-type: application/json'
```

---

## 1. 이벤트 넣기 (채널 키)

실제 웹훅이 하는 일이다. 본문은 해석하지 않고 그대로 저장된다.

```sh
curl -X POST "$CP/channels/demo/events" \
  -H "$JSON" -H 'x-channel-key: demo-channel-key' \
  -d '{"payload":"내일 오전 회의 일정 잡아줘"}'
```

```json
{ "taskId": "7501633a-…", "threadId": null }
```

**응답이 갈리는 지점이 여기다.** 채널이 `passthrough`면 이벤트 하나가 곧 Task 하나라
`taskId`가 온다. `claude`·`http` 해석 모드면 문맥 스레드에 쌓이므로 `taskId`는 `null`,
`threadId`가 채워진다 — 아직 Task가 아니라 축적 중이라는 뜻이다.

**같은 대화를 한 스레드로 묶으려면** `contextKey`를 넣는다. 발신처의 네이티브 키
(메일 `In-Reply-To`, Slack `thread_ts`, 이슈 번호)를 그대로 쓰면 된다:

```sh
curl -X POST "$CP/channels/mail/events" \
  -H "$JSON" -H 'x-channel-key: <채널 키>' \
  -d '{"payload":"로그인이 안 돼요","contextKey":"thread-42"}'
```

**처리할 에이전트를 생성 시점에 못박으려면** `agent`를 넣는다. claim 경합 없이 원자적이다:

```sh
curl -X POST "$CP/channels/demo/events" \
  -H "$JSON" -H 'x-channel-key: demo-channel-key' \
  -d '{"payload":"이 저장소에 README 초안 써줘","agent":"claude-code"}'
```

| 상태 | 뜻 |
| --- | --- |
| `200` | 받았다 |
| `400` | 본문이 스키마 위반 (`payload`가 비었다든가) |
| `401` | 채널이 없거나 키가 틀리다 — **둘을 구분해 알려주지 않는다.** 채널 id를 훑는 데 쓰이기 때문이다 |

---

## 2. 채널 관리 (관리 키)

### 등록하고 키 받기

```sh
curl -X POST "$CP/admin/channels" \
  -H "$JSON" -H "$ADMIN" \
  -d '{"id":"mail","label":"demo","interpreter":{"mode":"passthrough"}}'
```

```json
{
  "channel": { "id": "mail", "label": "demo", "source": "api", "disabledAt": null, "interpreter": {…} },
  "key": "ch_yU4caSIhNNwLLoPqXFU8FnU6g0roiOsa"
}
```

> **평문 키는 이 응답에서만 나온다.** 이후 조회에서는 `ch_yU…iOsa`처럼 가려진다.
> 잃어버렸으면 재발급밖에 없다.

주의할 것 둘:

- **`label`이 라우팅 기준이다.** 생략하면 `id`를 라벨로 쓰는데, **그 라벨을 보는 Worker가
  없으면 Task가 `pending`에서 영영 멈춘다.** Worker의 `worker.labels`와 맞춰야 한다.
- `id`는 URL에 들어가므로 영소문자·숫자·하이픈만 쓴다(`^[a-z0-9][a-z0-9-]*$`).

`interpreter`는 채널 YAML과 같은 모양이다([설정 문서](configuration.md#channelsinterpreter--해석-설정)).
생략하면 `passthrough`다. 해석을 켜려면:

```sh
curl -X POST "$CP/admin/channels" \
  -H "$JSON" -H "$ADMIN" \
  -d '{
    "id": "support",
    "label": "inbox",
    "interpreter": {
      "mode": "claude",
      "debounceMs": 5000,
      "labels": ["inbox", "ops"],
      "guidance": "이 채널은 고객 지원 메일함이다. 요금 문의는 ops로 분류한다."
    }
  }'
```

### 목록

```sh
curl "$CP/admin/channels" -H "$ADMIN"
```

```json
{ "channels": [
  { "id": "mail", "label": "demo", "source": "api", "disabledAt": null,
    "maskedKey": "ch_yU…iOsa", "interpreter": { "mode": "passthrough", … } },
  { "id": "demo", "label": "demo", "source": "config", "disabledAt": null,
    "maskedKey": "demo-…-key", "interpreter": { "mode": "passthrough", … } }
] }
```

`source`가 중요하다. **`config`는 설정 파일에서 온 채널이라 관리 API로 바꿀 수 없다** —
파일이 진실이라 고쳐봐야 다음 시작에 되돌아가기 때문이다(`403`). `samdi.server.yaml`을 고친다.

### 라벨·해석기 고치기

```sh
curl -X PATCH "$CP/admin/channels/mail" \
  -H "$JSON" -H "$ADMIN" \
  -d '{"label":"demo"}'
```

**키는 그대로다.** 등록할 때 아무도 안 보는 라벨을 골랐다는 건 나중에 알게 되는데,
그때 채널을 지웠다 다시 만들면 키까지 바뀌어 이미 설정해둔 웹훅을 전부 고쳐야 한다 —
라벨 하나 때문에 치를 값이 아니다.

해석기도 같은 방법으로 바꾼다(둘 중 하나만 줘도 되고, 안 준 쪽은 유지된다):

```sh
curl -X PATCH "$CP/admin/channels/mail" -H "$JSON" -H "$ADMIN" \
  -d '{"interpreter":{"mode":"passthrough"}}'
```

**이미 만들어진 Task의 라벨은 바뀌지 않는다.** 그건 "그때 이 라벨로 배달됐다"는 기록이고,
소급해 바꾸면 감사 기록이 거짓이 된다. 바뀐 라벨은 이후에 만들어지는 Task부터 적용된다.

### 키 재발급

```sh
curl -X POST "$CP/admin/channels/mail/key" -H "$ADMIN"
```

```json
{ "key": "ch_새로운키…" }
```

**예전 키는 그 즉시 막힌다.** 그 키를 쓰던 웹훅은 `401`을 받기 시작하므로 같이 바꿔야 한다.

### 비활성화와 삭제 — 다른 것이다

**비활성화**는 수신만 멈춘다. 채널도, 그 채널이 만든 Task도 남는다.
"이 채널은 이제 안 쓴다"에는 이쪽이 맞다.

```sh
curl -X POST "$CP/admin/channels/mail/disable" -H "$ADMIN"
```

목록에는 `disabledAt`이 찍힌 채로 남고, **같은 id로 다시 등록하면 새 키로 되살아난다.**

**삭제**는 목록에서 없앤다. 걸린 기록이 없으면 그냥 지워진다:

```sh
curl -X DELETE "$CP/admin/channels/mail" -H "$ADMIN"
```

```json
{ "ok": true, "removed": { "tasks": 0, "threads": 0 } }
```

걸린 기록이 있으면 **409로 거부하면서 몇 건인지 알려준다** — 화면이 "이만큼 함께
지워집니다"라고 물어볼 수 있게:

```json
{
  "error": "이 채널을 참조하는 기록이 있다: mail (Task 12건, 문맥 스레드 3건). …",
  "refs": { "tasks": 12, "threads": 3 }
}
```

기록째 지우려면 `purge`를 준다. **되돌릴 수 없다** — Task와 감사 이벤트, 본문,
문맥 스레드가 함께 사라진다:

```sh
curl -X DELETE "$CP/admin/channels/mail?purge=true" -H "$ADMIN"
```

기록을 남기고 싶으면 삭제 대신 비활성화를 쓴다.

### 채널이 도는지 확인 (키 없이 넣어보기)

```sh
curl -X POST "$CP/admin/channels/demo/events" \
  -H "$JSON" -H "$ADMIN" \
  -d '{"payload":"관리 화면에서 넣어본 이벤트"}'
```

채널 키가 필요 없는 이유는 관리 키가 이미 더 센 권한이기 때문이다. 응답은 1번과 같다.

---

## 3. 현황과 Task 조회

### 전체 현황 (관리 키)

```sh
curl "$CP/admin/overview" -H "$ADMIN"
```

```json
{
  "tasks":   { "pending": 1, "completed": 29, "failed": 10 },
  "threads": { "open": 1 },
  "workers": [
    { "workerId": "worker-1", "labels": ["demo"], "inFlight": 1,
      "firstSeenAt": "…", "lastSeenAt": "…", "leaseExpiresAt": "2026-08-15T13:07:46.655Z" }
  ],
  "coveredLabels": ["demo"],
  "channels": 3
}
```

**`coveredLabels`가 실용적으로 중요하다.** 최근 살아 있던 Worker들이 보는 라벨의 합집합이고,
**여기 없는 라벨로 만든 Task는 아무도 가져가지 않는다.** 채널을 만들 때 `label`을 생략하면
`id`가 라벨이 되므로 이 어긋남이 쉽게 생긴다 — 관리 화면은 그런 채널에 "Worker 없음"을 붙인다.

> Worker는 **따로 등록하지 않는다.** claim 요청이 이미 `{workerId, labels}`를 보내므로
> 서버가 그걸 받아 적는다. 그래서 일이 없어 놀고 있는 Worker도 목록에 나온다.
> 다만 일을 처리하는 동안에는 폴링이 멈추므로 `lastSeenAt`이 잠시 멀어진다 —
> "살아 있는가"는 폴링 주기보다 넉넉한 창(기본 5분)으로 판단한다.

### Task 목록 (Worker 키 또는 관리 키)

```sh
curl "$CP/tasks" -H "$ADMIN"                              # 기본: 진행 중인 것만, 최신순
curl "$CP/tasks?view=all&limit=25&offset=0" -H "$ADMIN"   # 종결분까지, 1페이지
curl "$CP/tasks?view=all&limit=25&offset=25" -H "$ADMIN"  # 2페이지
curl "$CP/tasks?status=stalled" -H "$ADMIN"               # 특정 상태만
```

```json
{ "tasks": [ … ], "total": 64 }
```

**기본이 진행 중만인 이유는 이게 UI의 폴링 경로이기 때문이다.** 완료건까지 초 단위로
실어 나르면 payload가 그냥 커진다. 끝난 것까지 보려면 `view=all`을 **명시**해야 한다.

`total`은 페이지 크기와 무관한 전체 수이고 필터를 반영한다 — 화면이 페이지 수를
계산하는 데 쓴다. `limit`은 1–200으로 잘린다.

### Task 상세 — 본문 + 감사 타임라인

```sh
curl "$CP/tasks/7501633a-a0af-49b9-bbe7-adc95feafa09" -H "$ADMIN"
```

```json
{
  "task": { "id": "7501633a-…", "status": "completed", "label": "sample-2", "workerId": "worker-1", … },
  "payload": "샘플 이벤트 — passthrough 채널 확인",
  "events": [
    { "type": "created",          "at": "…", "data": { "channelId": "sample-2", "label": "sample-2" } },
    { "type": "claimed",          "at": "…", "data": { "workerId": "worker-1", "leaseExpiresAt": "…" } },
    { "type": "report:waiting",   "at": "…", "data": { "question": "이 작업을 시작할까요?\n\n샘플 이벤트 …" } },
    { "type": "report:started",   "at": "…", "data": {} },
    { "type": "report:completed", "at": "…", "data": { "summary": "mock: … 처리 완료" } }
  ]
}
```

무슨 일이 있었는지는 여기서 읽는다. 위 예시는 **승인 대기 7초 뒤에 사람이 승인해서
실행된** 흔적이다.

### 문맥 스레드 (해석 모드 채널)

```sh
curl "$CP/channels/support/threads" -H "$ADMIN"
curl "$CP/threads/<threadId>" -H "$ADMIN"     # 스레드 + 쌓인 이벤트들
```

`eventSeq > interpretedSeq`면 아직 해석 안 한 이벤트가 있다는 뜻이다.
(시각이 아니라 시퀀스로 판단한다 — 같은 밀리초에 들어온 이벤트를 놓치지 않기 위해서다.)

---

## 4. Worker가 부르는 것 (Worker 키)

**직접 부를 일은 거의 없다.** Worker가 알아서 하는 것들이고, 여기 적는 이유는 다른
에이전트 런타임을 붙일 때 이 규약을 구현하면 되기 때문이다.

### claim — 원자적으로 하나 가져오기

```sh
curl -X POST "$CP/tasks/claim" \
  -H "$JSON" -H "$WK" \
  -d '{"workerId":"worker-1","labels":["demo"],"leaseSeconds":600}'
```

```json
{ "task": { "id": "…", "status": "claimed", … }, "payload": "내일 오전 회의 일정 잡아줘" }
```

일이 없으면 `{"task": null, "payload": null}`. 본문을 함께 내려주므로 따로 조회하지 않는다.
`leaseSeconds` 안에 보고가 없으면 서버가 `stalled`로 옮긴다.

### 진행 보고

```sh
curl -X POST "$CP/tasks/$TASK_ID/report" -H "$JSON" -H "$WK" -d '{"type":"started"}'
curl -X POST "$CP/tasks/$TASK_ID/report" -H "$JSON" -H "$WK" -d '{"type":"completed","summary":"메일 발송함"}'
```

여섯 가지가 있다:

| `type` | 필드 | 상태 전이 |
| --- | --- | --- |
| `started` | | `claimed`·`waiting` → `running` |
| `waiting` | `question` | → `waiting` (사람 결정 대기) |
| `resumed` | | `waiting` → `running` |
| `completed` | `summary?` | → `completed` |
| `failed` | `reason` | → `failed` |
| `rejected` | `reason` | → `rejected` (시작 자체를 거부) |

상태 머신에 없는 전이는 `409`다. 예를 들어 claim 없이 `completed`를 보내면 거부된다.

### heartbeat — 승인 대기가 길어져도 죽지 않게

```sh
curl -X POST "$CP/workers/worker-1/heartbeat" \
  -H "$JSON" -H "$WK" \
  -d '{"taskIds":["7501633a-…"],"leaseSeconds":600,"labels":["demo"]}'
```

```json
{ "extended": ["7501633a-…"] }
```

**`waiting`인 Task만 연장된다.** 사람이 승인 버튼을 늦게 누른다고 Task가 `stalled`로
빠지면 안 되기 때문이다. 반대로 진행 중(`claimed`·`running`)인 Task는 **일부러 연장하지
않는다** — 그걸 연장하면 에이전트가 조용히 죽은 경우(터미널 창을 그냥 닫는 등)를 영영
못 잡는데, 그게 lease가 잡으라고 있는 바로 그 상황이다.

Worker가 죽으면 heartbeat도 멈추므로 `waiting`도 결국 만료된다. 즉 이 연장이 기대는 것은
"Worker가 살아 있고 아직 이 Task를 붙들고 있다"는 사실 하나뿐이다.

Worker는 lease의 1/3 주기로 보내고, 연장할 게 없으면 아예 부르지 않는다.
감사 타임라인에는 남기지 않는다 — 주기적으로 도는 신호라 기록을 덮어버린다.

### 재시작 신고

```sh
curl -X POST "$CP/workers/worker-1/recover" -H "$WK"
```

```json
{ "recovered": ["7501633a-…"] }
```

Worker가 뜰 때 부른다. 그 Worker가 물고 있던 진행 중 Task를 `stalled`로 세운다 —
프로세스가 죽으면 에이전트도 승인 대기도 같이 사라지므로, 그대로 두면 승인 버튼도 없는
`waiting`에 갇힌다.

### 에이전트 지정 / stalled 처리

```sh
curl -X POST "$CP/tasks/$TASK_ID/agent" -H "$JSON" -H "$ADMIN" -d '{"agent":"claude-code"}'
curl -X POST "$CP/tasks/$TASK_ID/retry" -H "$JSON" -H "$ADMIN" -d '{"action":"retry"}'
```

에이전트 지정은 `pending` 동안만 된다(claim 후에는 `409`). `retry`는 `stalled`인 Task만
받고, 포기는 `{"action":"abandon"}`이다.

**`stalled`에서 자동으로 재시도하지 않는다.** 작업이 자연어이고 에이전트가 비결정적이라
"이미 메일이 나갔는지"를 시스템이 알 수 없다. 재시도도 일종의 시작이므로 사람이 정한다.

---

## 5. 에이전트가 부르는 것 (Worker 로컬 API)

에이전트 → Worker 방향의 **유일한** 채널이다. 어댑터가 의뢰 프롬프트에 이 주소와
사용법을 넣어준다.

### 완료 / 실패

```sh
curl -X POST "$WORKER/report/$TASK_ID" -H "$JSON" -d '{"type":"completed","summary":"한 줄 요약"}'
curl -X POST "$WORKER/report/$TASK_ID" -H "$JSON" -d '{"type":"failed","reason":"사유"}'
```

### 승인 요청 — 응답이 보류된다

```sh
curl -X POST "$WORKER/report/$TASK_ID" -H "$JSON" \
  -d '{"type":"ask","question":"고객에게 메일을 보내도 될까요?"}'
```

```json
{ "decision": "approve" }
```

**이 요청은 사람이 결정할 때까지 응답하지 않는다.** 동기 도구 호출처럼 동작하므로,
에이전트는 물어보고 답을 받는 한 번의 호출로 처리하면 된다. `approve`일 때만 진행하고,
`deny`면 Task는 이미 실패 처리된 상태다.

### Worker UI가 쓰는 것

```sh
curl "$WORKER/ui/state"                                    # 진행 중 + 승인 대기 + 라벨 + 활동 로그
curl "$WORKER/ui/agents"                                   # 쓸 수 있는 어댑터 목록
curl "$WORKER/ui/tasks"                                    # Control Plane 프록시 (키는 Worker에만)
curl -X POST "$WORKER/ui/tasks/$TASK_ID/approve" -H "$JSON" -d '{"decision":"approve"}'
curl -X POST "$WORKER/ui/tasks/$TASK_ID/resolve" -H "$JSON" -d '{"action":"retry"}'
```

`/ui/*`가 Control Plane을 프록시하는 이유는 **브라우저에 키를 주지 않기 위해서다.**
Worker가 자기 키로 대신 부른다.

### 운영값 바꾸기 — 재시작 없이

무슨 일을 받을지(`labels`)와 한 번에 몇 건을 감당할지(`concurrency`)는 **이 기기의
결정**이다. 자격 증명과 도구를 가진 쪽이 정하는 것이므로 관리 화면이 아니라 여기 있다.

```sh
curl -X POST "$WORKER/ui/labels" -H "$JSON" -d '{"labels":["demo","mail"]}'
curl -X POST "$WORKER/ui/labels" -H "$JSON" -d '{"reset":true}'      # 설정 파일 값으로
curl -X POST "$WORKER/ui/concurrency" -H "$JSON" -d '{"concurrency":3}'
curl -X POST "$WORKER/ui/default-agent" -H "$JSON" -d '{"agent":"claude-code"}'
```

**라벨은 다음 claim부터 적용된다.** 채널은 운영 중에 생기므로, 새 채널의 일을 받으려고
매번 재시작할 수는 없다.

**동시 처리 수는 늘리면 즉시, 줄이면 진행 중인 일이 끝난 뒤에 반영된다** — 사람이
승인하기를 기다리는 작업을 중간에 끊을 수는 없기 때문이다. 줄이는 중에는
`/ui/state`의 `runningLoops`가 `concurrency`보다 크게 보인다.

**기본 에이전트도 여기서 정한다.** Task마다 드롭다운으로 고르는 방법만 있으면
`pending`인 2초 남짓을 노려야 해서 잘 안 먹는다 — "내 일은 다 이걸로 돌린다"는
한 번 정해두는 게 맞다.

바꾼 값은 `~/.samdi/worker-state.json`에 남아 재시작해도 유지된다. 설정 파일(YAML)은
건드리지 않는다 — 손으로 적은 설정과 화면에서 만진 값이 한 파일에서 섞이면 무엇이
진실인지 알 수 없게 되기 때문이다. `/ui/state`가 둘을 함께 준다(`labels`,
`concurrency`, `configured`, `overridden`).

> 서버가 라벨 변경을 알게 되는 건 **다음 claim 때**다. Worker가 일을 처리하는 동안에는
> 폴링을 쉬므로, 그동안은 관리 화면의 `coveredLabels`가 옛 값으로 보인다.

### Task별 에이전트 지정 — 두 시점에 가능하다

```sh
curl -X POST "$WORKER/ui/tasks/$TASK_ID/agent" -H "$JSON" -d '{"agent":"claude-code"}'
```

아직 아무도 안 집었으면(`pending`) 서버의 Task에 박고, **이미 집혀서 승인을 기다리는
중이면 Worker가 들고 있다가 시작할 때 쓴다.** 어댑터는 승인 이후에 정해지므로 후자도
실제로 반영된다 — 응답의 `where`가 어느 쪽이었는지 알려준다(`worker` | 서버 응답).

이렇게 한 이유는 `pending`이 폴링 주기(2초)만큼밖에 안 가서, 그 창을 노려 드롭다운을
조작하는 게 사실상 불가능했기 때문이다.

### 막힌 Task를 사람이 끝내기

```sh
curl -X POST "$WORKER/ui/tasks/$TASK_ID/finish" -H "$JSON" \
  -d '{"outcome":"completed","note":"터미널에서 확인함"}'
curl -X POST "$WORKER/ui/tasks/$TASK_ID/finish" -H "$JSON" -d '{"outcome":"failed"}'
```

**에이전트가 보고 없이 끝났을 때 푸는 유일한 길이다.** Claude Code 터미널을 그냥 닫으면
정확히 이 상태가 되는데, 두면 lease가 만료될 때까지(기본 10분) 그 Task가 Worker를 붙들고
동시 처리 수가 1이면 뒤가 전부 막힌다.

감사 기록에는 **사람이 처리했다고 남는다**(`"사람이 직접 완료 처리함: …"`) —
에이전트가 보고한 것처럼 위장하지 않는다.

아직 시작 전(승인 대기)인 Task에는 쓸 수 없다(`409`). 그 단계에서 맞는 행동은
승인이나 거부다.

---

## 6. 한 바퀴 돌려보기

채널을 만들고, 이벤트를 넣고, 승인해서, 완료까지:

```sh
CP=http://127.0.0.1:3000
WORKER=http://127.0.0.1:4700
ADMIN='x-admin-key: demo-admin-key'
JSON='content-type: application/json'

# 1) 채널 등록 — label은 Worker가 보는 라벨과 맞춘다 (기본 Worker는 demo)
KEY=$(curl -s -X POST "$CP/admin/channels" -H "$JSON" -H "$ADMIN" \
  -d '{"id":"sample","label":"demo"}' | jq -r .key)

# 2) 발급받은 키로 이벤트 (실제 웹훅이 하는 일)
TASK=$(curl -s -X POST "$CP/channels/sample/events" -H "$JSON" -H "x-channel-key: $KEY" \
  -d '{"payload":"샘플 이벤트"}' | jq -r .taskId)

# 3) Worker가 집어가 Start Gate가 승인을 요청할 때까지 잠깐
sleep 3
curl -s "$WORKER/ui/state" | jq '.approvals'

# 4) 승인 (평소에는 Worker UI에서 버튼으로 누른다)
curl -s -X POST "$WORKER/ui/tasks/$TASK/approve" -H "$JSON" -d '{"decision":"approve"}'

# 5) 결과와 타임라인
sleep 2
curl -s "$CP/tasks/$TASK" -H "$ADMIN" | jq '{status: .task.status, events: [.events[].type]}'
```

```json
{
  "status": "completed",
  "events": ["created", "claimed", "report:waiting", "report:started", "report:completed"]
}
```

`jq`가 없으면 `scripts/send.sh`가 1·2번을 대신한다:

```sh
./scripts/send.sh -c sample -k "$KEY" "샘플 이벤트"
./scripts/send.sh -h     # 옵션 전체
```

---

## 오류 응답

전부 `{"error": "..."}` 형태다. 스키마 위반은 `issues`가 함께 온다.

| 코드 | 언제 |
| --- | --- |
| `400` | 본문이 스키마 위반 |
| `401` | 키가 없거나 틀리다 (채널은 "없는 채널"도 여기로 뭉뚱그린다) |
| `403` | 설정 파일에서 온 채널을 관리 API로 바꾸려 했다 |
| `404` | 없는 Task·스레드 |
| `409` | 상태 머신이 허용하지 않는 전이 / 이미 있는 채널 id / 걸린 기록이 있는 채널 삭제(`refs` 동봉) |
