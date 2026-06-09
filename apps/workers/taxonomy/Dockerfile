FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/workers/taxonomy/package.json apps/workers/taxonomy/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/workers/taxonomy apps/workers/taxonomy
RUN pnpm --filter shared build && pnpm --filter taxonomy-handler build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/workers/taxonomy/dist ./apps/workers/taxonomy/dist
COPY --from=builder /app/apps/workers/taxonomy/package.json ./apps/workers/taxonomy/
WORKDIR /app/apps/workers/taxonomy
CMD ["node", "dist/index.js"]
