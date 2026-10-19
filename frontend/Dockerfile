# WorkJournal dashboard — React + Vite SPA served by `vite preview`, which also
# proxies /api to the core service (preview.proxy in vite.config.ts).

FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
RUN addgroup -S workjournal && adduser -S workjournal -G workjournal
WORKDIR /app
# `vite preview` is the static server and lives in devDependencies, so the
# preview image keeps the workspace node_modules (documented tradeoff: the
# dashboard serves static files only; the API stays behind the core service).
COPY --from=build --chown=workjournal:workjournal /app/node_modules ./node_modules
COPY --from=build --chown=workjournal:workjournal /app/dist ./dist
COPY --from=build --chown=workjournal:workjournal /app/vite.config.ts ./vite.config.ts
COPY --from=build --chown=workjournal:workjournal /app/package.json ./package.json
USER workjournal

ENV VITE_CORE_URL=http://core:3737
EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:5173/ || exit 1

CMD ["./node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
