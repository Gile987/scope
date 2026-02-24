FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/coder-acp-copilot/package.json ./apps/workers/coder-acp-copilot/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY apps/workers/coder-acp-copilot/tsconfig.json ./apps/workers/coder-acp-copilot/
COPY apps/workers/coder-acp-copilot/src ./apps/workers/coder-acp-copilot/src/

RUN pnpm --filter shared build && pnpm --filter coder-acp-copilot build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
# Install system tools needed at runtime
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    git \
    && curl -LsSf https://astral.sh/uv/0.10.0/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"
RUN npm install -g @anthropic-ai/claude-code@2.1.37 @github/copilot@0.0.415
RUN mkdir -p /workspace
ENV NODE_ENV=development
ENV SERVICE_DIR=workers/coder-acp-copilot
ENV WORKER_NAME=coder-acp-copilot
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
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

# Install GitHub Copilot CLI globally
RUN npm install -g @anthropic-ai/claude-code@2.1.37 @github/copilot@0.0.415

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/coder-acp-copilot/package.json ./apps/workers/coder-acp-copilot/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/coder-acp-copilot/dist ./apps/workers/coder-acp-copilot/dist/

# Create workspace directory
RUN mkdir -p /workspace

WORKDIR /app/apps/workers/coder-acp-copilot

ENV WORKER_NAME=coder-acp-copilot

CMD ["node", "dist/index.js"]
