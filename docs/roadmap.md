# 로드맵

samdi가 지금 무엇을 하고, 다음에 무엇을 할지. 개요는 [README](../README.md) 참조.

## 동작하는 것

**오케스트레이션 골격**

- Task 생성과 전체 상태 머신 (`pending` → `claimed` → `running` → `completed`/`failed`, 기각·승인 대기·중단 포함)
- 원자적 claim + lease. lease 만료 시 자동 재배포하지 않고 `stalled`로 세우고 사람이 재시도를 승인한다
- Task 생명주기 전체를 남기는 감사 이벤트

**Execution Plane**

- Start Gate — "이 Task를 시작할 것인가"를 로컬에서 판정
- 어댑터 레지스트리 + Task별 에이전트 선택 (주입 시점 또는 pending 중 지정)
- 승인 흐름 (`ask` → `waiting` → 승인/거부). 동기 도구 호출처럼 동작해서, 에이전트는
  물어보고 답을 받는 한 번의 호출로 처리한다
- 로컬 보고 API — 에이전트 → Worker 방향의 유일한 채널

**연동·인터페이스**

- Claude Code 어댑터 2종: headless(`claude -p`), Terminal 창(macOS, 과정을 직접 보며 개입 가능)
- Worker UI — Task 목록·감사 타임라인·승인·에이전트 선택·수동 재시도
- YAML 설정 (env > 파일 > 기본값) + 채널 선언적 등록

## 다음

### 서버 해석 파이프라인

가장 큰 미구현 조각. 현재는 이벤트가 곧바로 Task가 되므로 실질적으로 `fast_pass` 전용 경로만 돈다.

- 문맥 스레드 저장 + 채널별 TTL 만료 처리
- 문맥 키 추출 — 소스 네이티브 키(메일 체인, Slack `thread_ts`, 이슈 번호) 우선, 없으면 LLM 배정
- 실제 LLM 해석기 — `fast_pass` / `needs_context` / `complete` / `noise` 판정 + debounce
- 라벨 카탈로그 — 해석기가 고를 수 있는 라벨의 닫힌 집합 (LLM이 임의 라벨을 만들지 않게)

### 배포

- **Dockerize** — Control Plane / Worker 이미지, docker-compose로 로컬 한 방 실행.
  Worker는 사용자 기기에서 도구에 접근해야 하므로 컨테이너 경계와 자격 증명 주입 방식을 먼저 정해야 한다
- **Helm 차트** — 쿠버네티스에 Control Plane 배포 (서버는 상태만 소유하므로 컨테이너화가 자연스럽다).
  SQLite → 외부 DB 전환 여부가 여기서 갈린다

### 신뢰성

- lease 연장(heartbeat) — 승인 대기가 길어질 때 `stalled`로 빠지지 않게
- 웹훅 중복 제거 — 제공자가 재전송할 때 delivery ID 기준 idempotency
- 감사 로그 보존 정책과 저장 위치 분리

### 관찰성·운영

- 에이전트 진행 상황 스트리밍 (`--output-format stream-json` → UI 진행 상세)
- 채널·Worker 등록과 키 발급 흐름 (현재는 설정 파일에 평문)
- Task 목록 필터·검색, 라벨별 통계

### 연동 확장

- 실제 채널: 메일, GitHub, Jira, Slack
- Claude Agent SDK 기반 어댑터 (CLI spawn 대신 SDK MCP 도구로 보고)
- 다른 에이전트 어댑터 (범용 규약이 실제로 범용인지 검증하는 의미)
