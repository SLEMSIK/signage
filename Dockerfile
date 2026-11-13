# syntax=docker/dockerfile:1

# Базовый образ: Node.js 22 LTS на Debian 13 (trixie), slim.
# Обновить Node внутри мажорной версии: docker compose build --pull
ARG NODE_IMAGE=node:22-trixie-slim

# ---- сборка: все зависимости, TypeScript, админка, плеер ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Инструменты сборки нужны только если для нативного модуля нет готовой сборки.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin/package.json packages/admin/
COPY packages/player/package.json packages/player/
RUN npm ci --no-audit --no-fund
COPY packages packages
RUN npm run build

# ---- только production-зависимости ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin/package.json packages/admin/
COPY packages/player/package.json packages/player/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- финальный образ ----
FROM ${NODE_IMAGE}
# ARG до первого FROM виден только в строках FROM — объявляем снова для LABEL.
ARG NODE_IMAGE
LABEL org.opencontainers.image.title="signage" \
      org.opencontainers.image.description="Digital signage: сервер, админка и плеер" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CONFIG_PATH=/config/config.yaml
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY packages/server/package.json packages/server/
COPY packages/server/drizzle packages/server/drizzle
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/admin/dist packages/admin/dist
COPY --from=build /app/packages/player/dist packages/player/dist
RUN mkdir -p /data/smb /data/local-media /data/db && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
