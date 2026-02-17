FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/coder-acp-claude-code/package.json ./apps/workers/coder-acp-claude-code/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY apps/workers/coder-acp-claude-code/tsconfig.json ./apps/workers/coder-acp-claude-code/
COPY apps/workers/coder-acp-claude-code/src ./apps/workers/coder-acp-claude-code/src/

RUN pnpm --filter shared build && pnpm --filter coder-acp-claude-code build

FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

# Install Python and uv for Python-based MCP servers
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    git \
    && curl -LsSf https://astral.sh/uv/0.10.0/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

# Add uv to PATH
ENV PATH="/root/.local/bin:$PATH"

# Install Claude Code ACP globally
RUN npm install -g @zed-industries/claude-code-acp@0.16.0

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/coder-acp-claude-code/package.json ./apps/workers/coder-acp-claude-code/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/coder-acp-claude-code/dist ./apps/workers/coder-acp-claude-code/dist/

# Create workspace directory
RUN mkdir -p /workspace

WORKDIR /app/apps/workers/coder-acp-claude-code

ENV WORKER_NAME=coder-acp-claude-code

CMD ["node", "dist/index.js"]
