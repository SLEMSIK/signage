# syntax=docker/dockerfile:1

# ---- сборка: все зависимости, TypeScript, админка, плеер ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin/package.json packages/admin/
COPY packages/player/package.json packages/player/
RUN npm ci
COPY packages packages
RUN npm run build

# ---- только production-зависимости ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin/package.json packages/admin/
COPY packages/player/package.json packages/player/
RUN npm ci --omit=dev && npm cache clean --force

# ---- финальный образ ----
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini && rm -rf /var/lib/apt/lists/*
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
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
