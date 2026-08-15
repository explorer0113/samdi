# Worker + 대시보드 (클라이언트) 이미지 — Execution Plane.
#
# Worker와 UI를 한 이미지에 담는다. 브라우저는 Worker의 로컬 API만 보므로
# 같은 출처에서 내보내면 프록시도 CORS 설정도 필요 없다.
#
# ⚠️ 이 컨테이너 안에서는 `claude-code` 어댑터가 동작하지 않는다.
#    그 어댑터는 macOS의 Terminal.app을 열어 사람이 개입할 수 있게 하는 것이고,
#    리눅스 컨테이너에는 Terminal도, 로그인된 Claude Code도 없다.
#    컨테이너로 돌릴 때는 `mock`으로 파이프라인을 확인하고,
#    실제 에이전트를 붙이려면 Worker를 호스트에서 직접 띄운다 (docs/docker.md).
#
# 빌드는 저장소 루트에서:
#   docker build -f apps/worker/Dockerfile -t samdi-worker .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── 의존성 + UI 빌드 ───────────────────────────────────────────────────────
FROM base AS build
COPY . .
# UI는 빌드해야 하므로 개발 의존성(vite)까지 필요하다.
RUN pnpm install --frozen-lockfile --filter @samdi/worker... --filter @samdi/worker-ui...
RUN pnpm --filter @samdi/worker-ui build
# 여기서 --prod로 가지치기하지 않는다: 소스를 tsx로 바로 실행하는데
# tsx 자체가 devDependency라, 걷어내면 실행이 안 된다.
# 이미지를 줄이려면 먼저 빌드 산출물(JS)을 내보내는 쪽으로 가야 한다.

# ── 실행 ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# 컨테이너 안에서 루프백에 묶으면 대시보드에 닿을 수 없다.
# 보고 API에는 인증이 없으므로, 호스트에서 -p 127.0.0.1:4700:4700 으로
# 루프백에만 노출하는 것이 전제다 (docs/docker.md).
ENV SAMDI_REPORT_HOST=0.0.0.0 \
    SAMDI_REPORT_PORT=4700 \
    SAMDI_UI_DIST=/app/apps/worker-ui/dist \
    SAMDI_CONTROL_PLANE_URL=http://control-plane:3000 \
    SAMDI_AGENT=mock

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 4700

# pnpm은 의존성을 패키지별로 격리해 둔다 — tsx는 /app/node_modules가 아니라
# 여기에 있다. 그래서 cwd가 앱 디렉토리여야 로더가 해석된다.
WORKDIR /app/apps/worker

# 설정 파일은 cwd에서 찾으므로, 컨테이너에서는 아무 데나 마운트하고
# SAMDI_WORKER_CONFIG로 가리키는 편이 낫다 (docs/docker.md).
CMD ["node", "--import", "tsx", "src/index.ts"]
