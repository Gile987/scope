FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/post-processor/package.json ./apps/workers/post-processor/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY apps/workers/post-processor/tsconfig.json ./apps/workers/post-processor/
COPY apps/workers/post-processor/src ./apps/workers/post-processor/src/
# Copy every handler manifest (handler.yaml = pp-atif, handler.taxonomy.yaml =
# pp-taxonomy, plus any future handlers). The registration jobs read these by
# HANDLER_YAML_PATH, so all must be present in the image.
COPY apps/workers/post-processor/handler*.yaml ./apps/workers/post-processor/

RUN pnpm --filter shared build && pnpm --filter post-processor build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=workers/post-processor
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/post-processor/package.json ./apps/workers/post-processor/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/post-processor/dist ./apps/workers/post-processor/dist/
COPY --from=builder /app/apps/workers/post-processor/handler*.yaml ./apps/workers/post-processor/

WORKDIR /app/apps/workers/post-processor

CMD ["node", "dist/index.js"]
