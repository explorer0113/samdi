# Control Plane (서버) 이미지 — 관리 화면 포함.
#
# 이쪽이 배포되는 쪽이다. 이벤트를 받아 해석하고 Task를 만들어 보관한다.
# 자격 증명도 도구도 여기 없다 — 경계가 곧 권한이다(README의 아키텍처 참조).
#
# 관리 화면(control-plane-ui)을 같은 이미지에 담는다. 그 화면이 보는 것이
# 이 서버가 소유한 상태이므로 여기 붙어 있는 게 자연스럽다.
#
# 빌드는 저장소 루트에서:
#   docker build -f apps/control-plane/Dockerfile -t samdi-control-plane .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── 의존성 ─────────────────────────────────────────────────────────────────
# better-sqlite3는 네이티브 모듈이다. 보통은 prebuilt를 받아오지만,
# 아키텍처에 prebuilt가 없으면 여기서 컴파일해야 하므로 툴체인을 둔다.
# 이 스테이지는 최종 이미지에 남지 않는다.
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile \
      --filter @samdi/control-plane... \
      --filter @samdi/control-plane-ui...
RUN pnpm --filter @samdi/control-plane-ui build

# ── 실행 ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# 컨테이너 네트워크 네임스페이스 안에서는 루프백에 묶으면 아무도 못 닿는다.
# 노출 범위는 호스트에서 -p로 정한다 (docs/docker.md).
ENV SAMDI_HOST=0.0.0.0 \
    PORT=3000 \
    SAMDI_DB_PATH=/data/samdi.sqlite \
    SAMDI_UI_DIST=/app/apps/control-plane-ui/dist

COPY --from=deps --chown=node:node /app /app

# SQLite 파일은 컨테이너 밖에 있어야 재시작해도 Task가 남는다.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

# pnpm은 의존성을 패키지별로 격리해 둔다 — tsx는 /app/node_modules가 아니라
# 여기에 있다. 그래서 cwd가 앱 디렉토리여야 로더가 해석된다.
WORKDIR /app/apps/control-plane

# 상태를 가진 쪽이므로, 종료 신호를 받으면 진행 중인 쓰기를 마치고 닫히도록
# tsx가 아니라 node가 PID 1이 되게 한다 (--import tsx는 로더만 얹는다).
#
# 설정 파일은 cwd에서 찾으므로, 컨테이너에서는 아무 데나 마운트하고
# SAMDI_SERVER_CONFIG로 가리키는 편이 낫다 (docs/docker.md).
CMD ["node", "--import", "tsx", "src/index.ts"]
