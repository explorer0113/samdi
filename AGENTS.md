# 에이전트 지침

이 저장소에서 작업하는 코딩 에이전트를 위한 문서다. 코드를 읽으면 알 수 있는 것은 적지 않았다 —
**읽어도 모르는 것, 그래서 무심코 깨뜨리게 되는 것**만 모았다.

설정 키를 다루는 일이라면 [docs/configuration.md](docs/configuration.md)가 우선이고,
그 8절에 키 추가 체크리스트가 있다.

## 명령

```sh
pnpm install
pnpm dev                      # Control Plane(:3000) + Worker(:4700) + UI(:5173), Ctrl+C로 셋 다 정리
pnpm typecheck
pnpm test                     # vitest run (전체)
pnpm lint
npx vitest run packages/config    # 일부만
```

pnpm 워크스페이스다. 개별 패키지는 `pnpm --filter @samdi/worker <script>`로 돌린다.
루트에서 `npx vite` 같은 걸 부르면 루트 bin이 잡혀 엉뚱한 버전이 뜬다.

## 한국어로 쓴다

주석, 커밋 메시지, 문서, 오류 메시지, 테스트 이름이 전부 한국어다. 식별자와 API 필드명만
영어다. 새 코드도 여기 맞춘다 — 절반만 한국어인 파일이 제일 나쁘다.

## 깨뜨리면 안 되는 것

이 프로젝트의 값어치는 대부분 **하지 않기로 한 것**에 있다. 아래는 다 의도된 제약이고,
"개선"처럼 보이는 변경이 정확히 이걸 되돌리곤 한다.

### 서버는 실행하지 않는다

Control Plane은 이벤트를 읽고 해석하고 Task를 만들어 보관하는 데까지다. 자격 증명도 도구도
서버에 없다. 서버가 뭔가를 실행하게 만드는 변경은 이 프로젝트의 전제를 없앤다.

실행은 사용자 기기의 Worker가 어댑터를 통해서만 한다.

### Worker에서 LLM을 부르지 않는다

해석·분류는 서버에서 **이벤트당 한 번** 돈다. Worker가 claim할 때마다 LLM을 돌리면 같은
판단을 Worker 수만큼 반복하는 낭비다. Worker 코드에 LLM 호출이 들어갈 자리는 없다.

### lease가 만료돼도 자동 재배포하지 않는다

만료된 Task는 `stalled`로 세워두고 **사람이** 재시도를 결정한다. 작업 내용이 자연어이고
에이전트가 비결정적이라, "이미 메일이 나갔는지"를 시스템이 알 방법이 없기 때문이다.
재시도도 일종의 시작이므로 Start Gate 철학과 같다.

타임아웃 뒤에 자동으로 다시 큐에 넣는 코드를 추가하지 않는다.

### 승인은 Start Gate가 강제한다

에이전트가 알아서 물어봐 주기를 기대하지 않는다. Worker가 시작 **전에** 게이트를 통과시키므로
어떤 에이전트를 붙이든 동작이 같다. 기본 정책은 "전부 승인, 명시한 채널·라벨만 면제"다.

승인 로직을 어댑터 안으로 옮기면 에이전트마다 동작이 갈린다 —
[`packages/policy-gateway`](packages/policy-gateway/)에 둔다.

### 상태 전이는 상태 머신을 통한다

[`packages/task-domain/src/state-machine.ts`](packages/task-domain/src/state-machine.ts)의
전이표에 없는 이동은 만들지 않는다. 상태를 직접 UPDATE하는 코드를 추가하지 말고 전이표를 먼저 고친다.
`waiting`이 두 방향(시작 전 승인 / 실행 중 승인)에서 오고 거부의 귀결이 각각
`rejected`와 `failed`로 다르다 — 이건 우연이 아니라 구분이다.

### 순서는 타임스탬프가 아니라 시퀀스로 본다

문맥 스레드의 미해석 이벤트 판정은 `eventSeq`/`interpretedSeq`(단조 증가)로 한다.
타임스탬프로 비교하면 **같은 밀리초에 들어온 이벤트가 유실된다** — 실제로 겪은 버그다.

### 보고 API는 인증이 없다

`POST /report/:taskId`는 로컬 에이전트가 쓰는 통로라 인증이 없다. 그래서 루프백에만 바인딩한다
(`worker.reportHost`, 기본 `127.0.0.1`). 이 기본값을 바꾸거나, 이 API를 외부에 노출하는
편의 기능을 추가하지 않는다. 컨테이너에서 `0.0.0.0`인 것은 네임스페이스가 격리돼 있고
호스트에서 `-p 127.0.0.1:...`로 다시 막는다는 전제다 ([docs/docker.md](docs/docker.md)).

### 브라우저에 키를 주지 않는다

UI는 Worker의 `/ui/*`만 본다. Control Plane 접근은 Worker가 자기 키로 프록시한다.
UI에서 Control Plane을 직접 부르게 만들면 키가 브라우저로 나간다.

### 폴링 기본은 진행 중인 것만

`GET /ui/tasks`는 기본이 active-only다. 완료건까지 초 단위로 실어 나르면 payload가 그냥 커진다
(4178바이트 → 12바이트로 줄인 적이 있다). 전체 목록은 `view=all`로 **명시할 때만** 온다.

## 자주 밟는 지뢰

**`--allowedTools`는 가변 인자다.** Claude Code에 프롬프트를 넘길 때 `--` 로 옵션 파싱을
끊지 않으면 프롬프트까지 도구 이름으로 삼켜져서, 세션이 빈 채로 열린다.
[`claude-code.ts`](packages/agent-adapter/src/claude-code.ts)의 인자 순서를 테스트가 고정하고 있다.

**에이전트 작업 디렉토리는 고정 경로여야 한다.** Claude Code의 폴더 신뢰 수락이 디렉토리
단위로 저장되므로, 임시 디렉토리를 쓰면 매번 다시 수락해야 해서 프롬프트가 바로 안 돈다.

**`pnpm start`는 watch가 아니다.** 서버 코드를 고치고 반영이 안 되면 대개 재시작을 안 한 것이다.
`pnpm dev`가 watch다.

**한글 입력기(IME)에서 Enter가 두 번 발화한다.** UI에서 키 입력을 다룰 때는
`e.nativeEvent.isComposing`을 확인한다. 안 하면 이벤트가 두 번 주입된다.

**better-sqlite3는 네이티브 모듈이다.** 호스트에서 설치한 `node_modules`를 컨테이너로
복사하면 안 된다 (`.dockerignore`가 막고 있다).

## 테스트

vitest. 테스트 파일은 소스 옆에 `*.test.ts`로 둔다.

**UI(`apps/worker-ui`)에는 테스트를 쓰지 않는다** — 아직 형태가 자주 바뀌는 실험용 화면이라
의도적으로 비워둔 것이다. 나머지는 전부 테스트가 있다.

동작을 검증하되 구현을 베끼지 않는다. 예를 들어 실행 스크립트 테스트는 문자열을 비교하는 대신
**스크립트를 실제로 실행해** 가짜 바이너리가 받은 인자를 확인한다 — 그래서 위의 `--` 버그를
회귀로 잡을 수 있다.

## 문서

- [README.md](README.md) — 무엇이고 왜인지, 빨리 돌려보기
- [docs/configuration.md](docs/configuration.md) — 설정 키 전체 + 작업 레시피
- [docs/docker.md](docs/docker.md) — 컨테이너로 돌리기
- [docs/roadmap.md](docs/roadmap.md) — 다음에 할 것

`SOP.md`는 설계 작업 노트이고 **gitignore되어 있다**. 커밋하지 않는다.
동작을 바꾸면 관련 문서를 같은 커밋에서 갱신한다 — 특히 설정 키는 위의 체크리스트를 따른다.
