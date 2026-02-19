FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/report-generator/package.json ./apps/workers/report-generator/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY apps/workers/report-generator/tsconfig.json ./apps/workers/report-generator/
COPY apps/workers/report-generator/src ./apps/workers/report-generator/src/

RUN pnpm --filter shared build && pnpm --filter report-generator build

FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/report-generator/package.json ./apps/workers/report-generator/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/report-generator/dist ./apps/workers/report-generator/dist/

WORKDIR /app/apps/workers/report-generator

CMD ["node", "dist/index.js"]
