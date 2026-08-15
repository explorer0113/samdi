# samdi

현실 세계의 이벤트를 범용 AI 에이전트에게 전달하는 오케스트레이션 레이어.

메일 한 통, 이슈 하나, 웹훅 하나가 도착했을 때 그걸 에이전트에게 시킬 작업으로 만들어 배달하고,
시작을 통제하고, 결과를 받아 기록한다. **에이전트에게는 실행 권한을 주지 않는다** —
자격 증명과 도구는 사용자 기기에만 있고, 서버는 이벤트를 읽고 해석할 수 있어도 실행할 수는 없다.

> 상태: 실험 단계. 오케스트레이션 골격(Task 생명주기·claim/lease·승인 흐름), 서버 해석
> 파이프라인, Claude Code 연동이 동작한다 ([로드맵](docs/roadmap.md)).

## 이게 뭘 해결하나

에이전트에게 실제 일을 맡기려면 두 가지가 필요하다. 현실의 사건이 에이전트에게 **닿아야** 하고,
그 에이전트가 **뭘 할 수 있는지 통제**돼야 한다. samdi는 그 사이에 들어간다.

- **이 프로젝트는 에이전트 런타임이 아니다.** 에이전트 루프를 소유하지 않는다.
  작업을 배달하고 시작시키고 보고를 받는 것까지가 범위이며, 판단과 실행은 에이전트 자신의 것이다.
- **신뢰 경계는 사용자 기기다.** 원격 에이전트는 제안하고, 로컬 게이트가 판정하고, 로컬 도구가 실행한다.
- **에이전트는 갈아끼울 수 있다.** 범용 실행 규약 + 어댑터. 첫 레퍼런스 구현은 Claude Code.

## 아키텍처

```mermaid
flowchart TB
    CH["지정 채널 · 웹훅"]

    subgraph CP["Control Plane · 서버"]
        COL["수집기 · 문맥 키 추출"]
        subgraph IN["해석기 · LLM"]
            TH[("문맥 스레드")]
            JG["판정 · 라벨 결정"]
            TH --> JG
        end
        DP["분배기 + Task 스토어"]
        COL --> TH
        JG --> DP
    end

    subgraph EP["Execution Plane · 사용자 기기"]
        WK["Worker · claim · 보고 수신"]
        GT["Start Gate"]
        AD["Agent Adapter"]
        WK --> GT
        GT --> AD
    end

    AG["대상 에이전트 · 외부"]

    CH -->|"이벤트 수신"| COL
    DP -->|"claim · 폴링"| WK
    AD -->|"시작 + 보고 지시"| AG
    AG -.->|"완료 · 실패 · 승인 요청"| WK
    WK -.->|"결과 중계"| DP
```

**위에서 아래가 정상 경로, 점선이 되돌아오는 보고다.** 서버는 수집기 → 해석기 → 분배기
세 단계로 흐른다. **문맥 스레드는 별도 단계가 아니라 해석기가 유지하는 상태다** — 수집기가
문맥 키로 이벤트를 스레드에 쌓고, 해석기는 그 스레드를 보고 판정한다.
Task가 만들어지면 사용자 기기의 Worker가 가져가 Start Gate를 통과한 것만 에이전트에게 넘기고,
에이전트의 보고는 Worker의 로컬 API로 돌아와 서버에 중계된다.

경계가 곧 권한이다. **서버는 이벤트를 읽고 해석할 수 있어도 실행할 수는 없고**, 자격 증명과
도구는 아래쪽 사용자 기기에만 있다. 대상 에이전트는 두 상자 밖에 있다 — 이 프로젝트가 소유하지 않는다.

이벤트와 Task는 1:1이 아니다. 웹훅은 문맥 키별로 **문맥 스레드**에 쌓이고, 해석기가 이벤트마다
네 가지로 판정한다 — `fast_pass`(자기완결적 단순 요청, 즉시 배달) / `needs_context`(더 기다림) /
`complete`(문맥 완성) / `noise`(폐기). 해석·분류 LLM은 서버에서 이벤트당 한 번만 돈다.
Worker마다 claim할 때마다 LLM을 돌리는 건 낭비이기 때문이다.

Start Gate가 기각하거나 lease가 만료되는 예외 경로는 아래 상태도에 있다.

**해석은 채널마다 설정한다.** 기본값은 `passthrough` — LLM을 전혀 호출하지 않고 이벤트 하나가 곧 Task 하나가 된다.
`claude`(내장 구현)나 `http`(다른 LLM에 위임)로 바꾸면 위 그림대로 문맥 스레드에 쌓였다가 해석기가 판정한다.
**프롬프트도 설정에 있다** — 채널별 맥락은 `guidance`로 덧붙이고, 필요하면 `systemPrompt`로 통째로 갈아끼운다.
TTL·debounce·라벨 카탈로그도 마찬가지다 ([설정 문서](docs/configuration.md#channelsinterpreter--해석-설정)).

해석기 자체는 인터페이스다(`interpret(input) → 판정`). 내장 구현이 안 맞으면 `mode: http`로 바깥에 맡기거나,
직접 만든 구현을 팩토리로 끼워넣는다 — 파이프라인은 그대로다.

### Task 생명주기

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> claimed: claim
    claimed --> running: Gate 통과
    claimed --> rejected: Gate 기각
    running --> waiting: 승인 요청
    waiting --> running: 승인
    waiting --> failed: 거부
    running --> completed: 완료
    running --> failed: 실패
    running --> stalled: lease 만료
    stalled --> pending: 재시도
    stalled --> failed: 포기
```

**lease가 만료돼도 자동으로 재배포하지 않는다.** 작업 내용이 자연어이고 에이전트가 비결정적이라
"이미 메일이 나갔는지"를 시스템이 알 수 없다. 그래서 `stalled`로 세워두고 사람이 재시도를 승인한다 —
재시도도 일종의 시작이므로 Start Gate 철학과 같다.

## 빨리 돌려보기

Node.js 22+ / pnpm이 필요하다. 설정 파일 없이 데모 기본값으로 돈다.

```sh
pnpm install
```

터미널 세 개로:

```sh
# 1) Control Plane (:3000)
pnpm --filter @samdi/control-plane start

# 2) Worker — 로컬 보고 API + UI용 API (:4700)
pnpm --filter @samdi/worker start

# 3) Worker UI (http://localhost:5173)
pnpm --filter @samdi/worker-ui dev
```

브라우저에서 <http://localhost:5173> 을 열고 **이벤트 주입**에 아무 내용이나 넣으면,
Task가 만들어져 claim → Start Gate → mock 에이전트 → 완료까지 흐르는 걸 볼 수 있다.
Task를 클릭하면 본문과 감사 이벤트 타임라인이 보인다.

- 내용에 **"승인"** 을 넣으면 mock 에이전트가 승인을 요청한다 → 목록 행에 승인/거부 버튼이 뜬다.
- 주입 폼의 드롭다운에서 **에이전트를 고를 수 있다**(`mock` / `claude-code` / `claude-code-terminal`).

CLI로도 같은 조작이 된다:

```sh
cd apps/demo-cli
pnpm start inject "내일 오전 회의 일정 잡아줘"
pnpm start list
pnpm start show <taskId>      # 본문 + 감사 이벤트
pnpm start retry <taskId>     # stalled 재시도 / abandon 으로 포기
```

### 실제 에이전트(Claude Code)로 돌리기

[Claude Code](https://claude.com/claude-code)가 설치돼 있으면 어댑터를 바꾸기만 하면 된다:

```sh
SAMDI_AGENT=claude-code pnpm --filter @samdi/worker start
```

Worker가 headless로 Claude Code를 실행하고, 의뢰 프롬프트에 **보고 규약**(완료·실패·승인 요청을
로컬 보고 API로 보내는 방법)을 함께 넣는다. 에이전트가 보고를 잊고 종료하면 어댑터가 종료 코드를 보고 대신 보고한다.

`claude-code-terminal`을 고르면 백그라운드가 아니라 **Terminal 창이 열려** 에이전트가 일하는 과정을
직접 보고 개입할 수 있다(macOS).

실행 정책은 Claude Code 자신의 권한 체계에 맡긴다 — `allowedTools`/`permissionMode`로 조정한다.
기본값은 보고용 `Bash(curl *)`만 허용하므로, 파일을 만들거나 명령을 실행하게 하려면 열어줘야 한다
([설정 문서](docs/configuration.md#에이전트가-실제로-파일을-만들고-명령을-실행하게-한다)).

## 설정

YAML + zod 검증. **설정 파일은 없어도 되고**, 환경변수가 파일을 덮는다.

```sh
cp samdi.server.example.yaml samdi.server.yaml   # Control Plane
cp samdi.worker.example.yaml samdi.worker.yaml   # Worker
```

전체 키·환경변수 매핑·작업 레시피는 **[docs/configuration.md](docs/configuration.md)** 에 있다.
사람과 코딩 에이전트가 같은 문서로 설정을 바꿀 수 있게 쓰였다.

## 구조

```
apps/
  control-plane/   수집기 → 해석기 → 분배기 + Task 상태/생명주기 API
  worker/          claim → Start Gate → 어댑터 → 보고 중계 (+ UI용 로컬 API)
  worker-ui/       사용자 기기 대시보드 (React + Vite)
  demo-cli/        end-to-end 조작용 CLI

packages/
  config/          YAML 설정 스키마·로더 (env > 파일 > 기본값)
  protocol/        공유 스키마: Task, 문맥 스레드, 상태 머신, API 계약, 판정 타입
  task-domain/     상태 전이 규칙, 본문 저장소 인터페이스
  interpreter/     해석기 인터페이스 + 내장 구현 (passthrough / claude / http)
  agent-adapter/   에이전트 실행 규약 + 어댑터 (mock, Claude Code)
  policy-gateway/  Start Gate + allow/deny/ask 판정
  tool-sdk/        에이전트에게 붙여줄 MCP 도구 (예정)
```

브라우저는 Worker의 로컬 API만 본다. Control Plane 접근은 Worker가 자기 키로 프록시하므로
UI에 키가 노출되지 않고, 승인·재시도 같은 사용자 결정은 사용자 기기에서 내려진다.

## 개발

```sh
pnpm typecheck
pnpm test
pnpm lint
```

TypeScript / Node 22+ / pnpm workspace / Fastify / SQLite(better-sqlite3) / zod / Vitest.

## 로드맵

Task 생명주기·claim/lease·승인 흐름·서버 해석 파이프라인·Claude Code 연동은 동작한다.
배포(Docker·Helm), 실제 채널 연동, 문맥 키 자동 배정이 다음 순서다.

전체 목록: **[docs/roadmap.md](docs/roadmap.md)**

## 라이선스

[MIT](LICENSE)
