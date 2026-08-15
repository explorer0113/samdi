# Docker로 돌리기

이미지는 둘이다. **아키텍처의 두 평면이 그대로 이미지 경계가 된다.**

| 이미지 | 무엇 | Dockerfile |
| --- | --- | --- |
| 서버 | Control Plane — 이벤트 수집·해석·Task 보관 | `apps/control-plane/Dockerfile` |
| 클라이언트 | Execution Plane — Worker + 대시보드 | `apps/worker/Dockerfile` |

대시보드는 별도 이미지가 아니다. 브라우저는 Worker의 로컬 API만 보므로,
빌드한 정적 파일을 Worker가 같은 출처로 내보낸다 — 프록시도 CORS 설정도 없다.

## 먼저 읽을 것 — 컨테이너에서 못 하는 일

**`claude-code` 어댑터는 컨테이너 안에서 동작하지 않는다.** 그 어댑터는 macOS의
Terminal.app을 열어 사람이 진행 과정을 보고 개입하게 하는 것인데, 리눅스 컨테이너에는
Terminal도 없고 로그인된 Claude Code도 없다. 그래서 Worker 이미지의 기본 에이전트는
`mock`이다.

이건 포장이 덜 된 게 아니라 **설계가 그렇다.** 자격 증명과 도구는 사용자 기기에 있고,
Worker는 그 기기에서 도는 것이 전제다. 그래서 현실적인 조합은 이렇게 갈린다:

- **서버만 컨테이너로, Worker는 호스트에서** — 실제로 쓸 때의 모양. 서버는 어디든
  배포하고, 에이전트를 실제로 돌리는 Worker는 자기 기기에서 띄운다.
- **둘 다 컨테이너로** — `mock`으로 파이프라인 전체(수집 → 해석 → Task → 승인 → 보고)를
  확인할 때. `docker compose up`이 이 구성이다.

## 둘 다 컨테이너로 (파이프라인 확인용)

```sh
docker compose up --build
```

포트가 이미 쓰이고 있으면(3000은 흔하다) 호스트 쪽 포트만 바꾼다:

```sh
SAMDI_CP_PORT=3001 SAMDI_UI_PORT=4701 docker compose up --build
```

대시보드는 <http://127.0.0.1:4700> 이다. `pnpm dev`로 띄웠을 때의 5173이 아니다 —
컨테이너에서는 vite 개발 서버가 없고 Worker가 UI를 직접 내보낸다.

**이벤트 주입**에 아무 내용이나 넣으면 Task가 만들어지고, 목록 행에 승인/거부 버튼이 뜬다.
승인하면 mock 에이전트가 실행되고 완료 보고까지 돌아온다.

외부 웹훅을 흉내내려면:

```sh
./scripts/send.sh -u http://127.0.0.1:3000 "내일 오전 회의 일정 잡아줘"
```

정리:

```sh
docker compose down          # 컨테이너만
docker compose down -v       # Task 기록(볼륨)까지
```

## 서버만 컨테이너로, Worker는 호스트에서 (실제 구성)

이쪽이 실제로 쓰는 모양이다. 에이전트를 진짜로 돌리려면 Worker가 호스트에 있어야 한다.

```sh
# 1) 서버만 띄운다
docker compose up -d --build control-plane

# 2) Worker는 호스트에서 — 여기에만 자격 증명과 도구가 있다
SAMDI_CONTROL_PLANE_URL=http://127.0.0.1:3000 \
SAMDI_AGENT=claude-code \
pnpm --filter @samdi/worker start

# 3) 대시보드
pnpm --filter @samdi/worker-ui dev
```

## 이미지 따로 빌드하기

컨텍스트는 **항상 저장소 루트**다. pnpm 워크스페이스라 이미지 안에서 다른 패키지를
참조해야 하기 때문에, `apps/control-plane/`에서 빌드하면 실패한다.

```sh
docker build -f apps/control-plane/Dockerfile -t samdi-control-plane .
docker build -f apps/worker/Dockerfile        -t samdi-worker         .
```

## 설정

[docs/configuration.md](configuration.md)의 키가 전부 그대로 통한다. 컨테이너에서는
환경변수가 편하고, 파일을 쓰고 싶으면 마운트한 뒤 **경로를 명시**한다:

```yaml
services:
  control-plane:
    environment:
      SAMDI_SERVER_CONFIG: /config/server.yaml
    volumes:
      - ./samdi.server.yaml:/config/server.yaml:ro
```

경로를 명시하는 이유는, 설정 파일 자동 탐색이 cwd 기준인데 컨테이너의 cwd가
`/app/apps/control-plane`이라 직관과 어긋나기 때문이다. Worker는
`SAMDI_WORKER_CONFIG`로 같은 방식이다.

키가 든 설정 파일은 `.dockerignore`에 있어 이미지에 구워지지 않는다. 의도한 것이다 —
키는 마운트하거나 환경변수로 준다.

이미지가 기본값과 다르게 잡아두는 것만 정리하면:

| 환경변수 | 이미지 기본값 | 왜 |
| --- | --- | --- |
| `SAMDI_HOST` (서버) | `0.0.0.0` | 컨테이너 안에서 루프백에 묶으면 아무도 못 닿는다 |
| `SAMDI_DB_PATH` (서버) | `/data/samdi.sqlite` | 볼륨에 둬야 재시작해도 Task가 남는다 |
| `SAMDI_REPORT_HOST` (Worker) | `0.0.0.0` | 위와 같은 이유 |
| `SAMDI_UI_DIST` (Worker) | `/app/apps/worker-ui/dist` | 빌드된 대시보드를 같은 출처로 서빙 |
| `SAMDI_AGENT` (Worker) | `mock` | 컨테이너에서는 `claude-code`를 못 쓴다 |

## 포트를 열 때 주의할 것

`0.0.0.0`으로 바꾼 건 **컨테이너 안쪽 바인딩**이지 노출 범위가 아니다. 노출은
`ports:`가 정하고, compose는 둘 다 `127.0.0.1`에만 매핑한다.

**Worker의 4700은 루프백 밖으로 내보내면 안 된다.** 보고 API에는 인증이 없다 —
에이전트가 로컬에서 보고하는 통로라는 전제로 만들어졌기 때문이다. 이걸 열면 같은
네트워크의 누구나 Task 완료·실패를 위조하고 승인 질문에 답할 수 있다.

서버의 3000은 채널 웹훅이 들어오는 곳이라 열어야 할 수 있다. 그때는
`samdi.server.yaml`의 채널 키를 반드시 실제 값으로 바꾼다 — 기본값 `demo-channel-key`가
그대로면 아무나 Task를 만들 수 있다. `workerKey`도 마찬가지다.

## 잘 안 될 때

**Worker가 서버에 못 붙는다** — 컨테이너끼리는 서비스 이름으로 통신한다.
`SAMDI_CONTROL_PLANE_URL`이 `http://control-plane:3000`이어야 하고,
`127.0.0.1`이면 자기 자신을 가리켜 실패한다. 반대로 호스트에서 Worker를 띄웠다면
`http://127.0.0.1:3000`이 맞다.

**빌드가 better-sqlite3에서 멈춘다** — 네이티브 모듈이라 prebuilt가 없으면 컴파일한다.
서버 이미지는 빌드 스테이지에 툴체인(`python3 make g++`)을 두고 있고, 최종 이미지에는
남지 않는다. 오래 걸릴 수는 있어도 실패하면 안 된다.

**대시보드가 빈 화면이다** — Worker 로그에 `serving worker-ui`가 있는지 본다.
`uiDist 경로가 없다`가 찍혔으면 UI 빌드가 이미지에 안 들어간 것이다.

**Task가 계속 `stalled`로 간다** — lease 만료다. mock이 아닌 에이전트가 보고를 안 하고
끝났다는 뜻이고, 컨테이너에서 `claude-code`를 지정했을 때 나오는 증상이다.
설계상 자동 재배포하지 않으므로 사람이 재시도를 결정한다.
