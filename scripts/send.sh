#!/usr/bin/env bash
# 채널에 이벤트를 하나 보낸다 (외부 웹훅이 하는 일과 같다).
#
#   ./scripts/send.sh "내일 회의 잡아줘"
#   ./scripts/send.sh -c mail -k mail-key -x thread-42 "로그인이 안 돼요"
#
#   -c 채널 id      (기본 demo)
#   -k 채널 키      (기본 demo-channel-key, 또는 SAMDI_CHANNEL_KEY)
#   -x 문맥 키      (llm 해석 채널에서 같은 스레드로 묶을 때)
#   -a 에이전트     (mock | claude-code | claude-code-terminal)
#   -u 서버 주소    (기본 http://127.0.0.1:3000, 또는 SAMDI_CONTROL_PLANE_URL)
set -euo pipefail

CHANNEL=demo
KEY="${SAMDI_CHANNEL_KEY:-demo-channel-key}"
URL="${SAMDI_CONTROL_PLANE_URL:-http://127.0.0.1:${PORT:-3000}}"
CONTEXT_KEY=""
AGENT=""

while getopts ":c:k:x:a:u:h" opt; do
  case $opt in
    c) CHANNEL=$OPTARG ;;
    k) KEY=$OPTARG ;;
    x) CONTEXT_KEY=$OPTARG ;;
    a) AGENT=$OPTARG ;;
    u) URL=$OPTARG ;;
    h) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "모르는 옵션: -$OPTARG" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

PAYLOAD="${*:-}"
if [ -z "$PAYLOAD" ]; then
  echo "보낼 내용이 없다. 사용법: $0 [옵션] \"내용\"  (-h 로 도움말)" >&2
  exit 1
fi

BODY=$(PAYLOAD="$PAYLOAD" CONTEXT_KEY="$CONTEXT_KEY" AGENT="$AGENT" python3 -c '
import json, os
body = {"payload": os.environ["PAYLOAD"]}
if os.environ["CONTEXT_KEY"]: body["contextKey"] = os.environ["CONTEXT_KEY"]
if os.environ["AGENT"]: body["agent"] = os.environ["AGENT"]
print(json.dumps(body, ensure_ascii=False))
')

# 연결 자체가 실패해도 아래 안내를 띄우기 위해 curl 실패를 흡수한다.
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST "${URL}/channels/${CHANNEL}/events" \
  -H 'content-type: application/json' \
  -H "x-channel-key: ${KEY}" \
  -d "$BODY" 2>/dev/null || true)
STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
BODY_OUT=$(printf '%s' "$RESPONSE" | sed '$d')
[ -z "$STATUS" ] && STATUS=000

if [ "$STATUS" != "200" ]; then
  echo "실패 (HTTP $STATUS): $BODY_OUT" >&2
  case "$STATUS" in
    404) echo "힌트: 채널 '${CHANNEL}'이 설정에 없다. samdi.server.yaml의 channels 확인." >&2 ;;
    401) echo "힌트: 채널 키가 다르다. -k 또는 SAMDI_CHANNEL_KEY 확인." >&2 ;;
    000) echo "힌트: ${URL} 에 연결할 수 없다. Control Plane이 떠 있나?" >&2 ;;
  esac
  exit 1
fi

printf '%s' "$BODY_OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
task_id = d.get("taskId")
if task_id:
    print("Task 생성됨: " + task_id)
else:
    print("문맥 스레드에 축적됨: " + str(d.get("threadId")) + " (해석기 판정 대기)")
'
