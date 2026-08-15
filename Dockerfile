# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# ---------- build: devDependencies ありで tsc ----------
FROM node:${NODE_VERSION}-alpine AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
 && test -f dist/src/http.js \
 && test -f dist/src/index.js

# ---------- prod-deps: 実行時だけの node_modules ----------
FROM node:${NODE_VERSION}-alpine AS prod-deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="notion-ai-mcp" \
      org.opencontainers.image.description="Personal-use MCP server for Notion AI's unofficial internal API" \
      org.opencontainers.image.source="https://github.com/nmt3325/notion-ai-mcp"
RUN apk add --no-cache tini curl
WORKDIR /app
ENV NODE_ENV=production \
    NOTION_MCP_HTTP_HOST=0.0.0.0 \
    NOTION_MCP_HTTP_PORT=3000 \
    NOTION_MCP_HTTP_PATH=/mcp \
    NOTION_ATTACHMENT_ROOT=/data \
    NOTION_TIMEZONE=Asia/Tokyo
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md ./
COPY docs ./docs
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
# /healthz は Bearer 認証なしで 200 を返す
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${NOTION_MCP_HTTP_PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# 既定は Remote Streamable HTTP。stdio は command を上書き:
#   docker run -i --rm --env-file .env IMAGE node dist/src/index.js
CMD ["node", "dist/src/http.js"]
