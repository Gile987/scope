FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/

RUN pnpm install --frozen-lockfile

COPY packages/api/tsconfig.json ./packages/api/
COPY packages/api/src ./packages/api/src/

RUN pnpm --filter api build

FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api/package.json ./packages/api/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/api/dist ./packages/api/dist/

WORKDIR /app/packages/api

EXPOSE 80

ENV PORT=80

CMD ["node", "dist/index.js"]
