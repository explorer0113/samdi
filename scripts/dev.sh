#!/usr/bin/env bash
# samdi 전체 스택을 한 번에 띄운다: Control Plane → Worker → Worker UI.
# Ctrl+C 한 번으로 셋 다 정리된다.
#
# 포트는 환경변수로 바꾼다 (설정 파일에서 포트를 바꿨다면 여기도 맞춰야 한다):
#   PORT=3000  SAMDI_REPORT_PORT=4700  UI_PORT=5173
#
# 그 밖의 설정은 평소대로 samdi.server.yaml / samdi.worker.yaml 또는
# SAMDI_SERVER_CONFIG / SAMDI_WORKER_CONFIG 환경변수를 따른다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
SAMDI_REPORT_PORT="${SAMDI_REPORT_PORT:-4700}"
UI_PORT="${UI_PORT:-5173}"
export PORT SAMDI_REPORT_PORT
export SAMDI_CONTROL_PLANE_URL="${SAMDI_CONTROL_PLANE_URL:-http://127.0.0.1:${PORT}}"

if [ ! -d node_modules ]; then
  echo "의존성이 없다. pnpm install 먼저 실행한다." >&2
  exit 1
fi

PIDS=()

# pnpm → tsx/vite로 이어지는 자식까지 훑어서 정리한다.
# (`kill 0`은 비대화형 실행에서 호출한 셸까지 같은 그룹이라 위험하다.)
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "종료 중..."
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 실행은 pnpm에 맡긴다 — 각 패키지가 선언한 바이너리 버전이 쓰이도록.
# (루트 node_modules/.bin을 직접 찌르면 다른 버전이 잡힐 수 있다.)
run() { # run <라벨> <패키지>
  local label=$1 pkg=$2
  # awk + fflush로 줄마다 흘려보낸다. sed는 파이프에서 블록 버퍼링이라
  # 출력이 적은 프로세스(vite)의 로그가 묻힌다.
  # 프로세스 치환을 쓰면 $!가 awk가 아니라 pnpm의 PID가 된다.
  pnpm --filter "$pkg" dev > >(awk -v l="[$label] " '{ print l $0; fflush() }') 2>&1 &
  PIDS+=("$!")
}

echo "Control Plane 시작 (:${PORT})"
run cp @samdi/control-plane

# Worker가 먼저 떠서 연결 오류를 뿜지 않도록 기다린다.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Control Plane이 뜨지 않았다. 위 [cp] 로그를 확인한다." >&2
  exit 1
fi

echo "Worker 시작 (로컬 API :${SAMDI_REPORT_PORT})"
run worker @samdi/worker

echo "Worker UI 시작 (:${UI_PORT})"
export UI_PORT   # vite.config.ts가 읽는다
run ui @samdi/worker-ui

cat <<EOF

  UI      http://localhost:${UI_PORT}
  API     http://127.0.0.1:${PORT}
  이벤트  ./scripts/send.sh "내일 회의 잡아줘"

  Ctrl+C 로 전부 종료

EOF

wait
