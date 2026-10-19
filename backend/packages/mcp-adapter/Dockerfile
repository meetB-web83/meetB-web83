# syntax=docker/dockerfile:1
# WorkJournal MCP adapter — Streamable HTTP endpoint (stdio stays available for
# native dev). Build context is backend/ (shares the workspace lockfile).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/mcp-adapter/package.json packages/mcp-adapter/
COPY packages/cli/package.json packages/cli/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter @workjournal/shared --filter @workjournal/mcp-adapter

COPY packages/shared packages/shared
COPY packages/mcp-adapter packages/mcp-adapter
RUN pnpm --filter @workjournal/shared build \
 && pnpm --filter @workjournal/mcp-adapter build \
 && pnpm --filter @workjournal/mcp-adapter deploy --prod /out

FROM base AS runtime
RUN addgroup -S workjournal && adduser -S workjournal -G workjournal
WORKDIR /app
COPY --from=build --chown=workjournal:workjournal /out ./

# HTTP transport inside the container; core is reached via the Compose service
# name (never localhost). Host/Origin allowlists default to the published
# loopback endpoint unless overridden via the environment.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_PORT=3738 \
    WORKJOURNAL_CORE_URL=http://core:3737
USER workjournal
EXPOSE 3738

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3738/healthz || exit 1

CMD ["node", "dist/index.js"]
