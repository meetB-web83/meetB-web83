# syntax=docker/dockerfile:1
# WorkJournal core service — multi-stage build from the backend pnpm workspace.
# Build context is backend/ (shares the workspace lockfile with sibling packages).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

FROM base AS build
WORKDIR /app

# Workspace manifests first, for dependency-layer caching. All package.json
# files must be present so pnpm can validate the workspace lockfile.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/mcp-adapter/package.json packages/mcp-adapter/
COPY packages/cli/package.json packages/cli/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter @workjournal/shared --filter @workjournal/core

COPY packages/shared packages/shared
COPY packages/core packages/core
RUN pnpm --filter @workjournal/shared build \
 && pnpm --filter @workjournal/core build \
 && pnpm --filter @workjournal/core deploy --prod /out

FROM base AS runtime
RUN addgroup -S workjournal && adduser -S workjournal -G workjournal
WORKDIR /app
COPY --from=build --chown=workjournal:workjournal /out ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3737 \
    WORKJOURNAL_HOME=/data \
    LOG_LEVEL=info
RUN mkdir -p /data && chown workjournal:workjournal /data
USER workjournal
VOLUME /data
EXPOSE 3737

# node:sqlite (used by core) is unflagged since Node 22.13; base image is 22-alpine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3737/health || exit 1

CMD ["node", "dist/main.js"]
