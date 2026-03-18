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

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ARG CLAUDE_CODE_ACP_VERSION
RUN test -n "$CLAUDE_CODE_ACP_VERSION" || (echo 'CLAUDE_CODE_ACP_VERSION build-arg is required' && exit 1)
# Install system tools needed at runtime
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    git \
    && curl -LsSf https://astral.sh/uv/0.10.0/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"
RUN npm install -g @zed-industries/claude-code-acp@${CLAUDE_CODE_ACP_VERSION}

# Use existing node user (UID 1000) so claude-code-acp allows bypassPermissions mode
RUN mkdir -p /workspace && chown node:node /workspace
# Copy uv to a shared location accessible by non-root user
RUN cp -r /root/.local/bin/* /usr/local/bin/ 2>/dev/null || true

ENV NODE_ENV=development
ENV SERVICE_DIR=workers/coder-acp-claude-code
ENV WORKER_NAME=coder-acp-claude-code
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
USER node
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

# Install Claude Code ACP globally
ARG CLAUDE_CODE_ACP_VERSION
RUN test -n "$CLAUDE_CODE_ACP_VERSION" || (echo 'CLAUDE_CODE_ACP_VERSION build-arg is required' && exit 1)
RUN npm install -g @zed-industries/claude-code-acp@${CLAUDE_CODE_ACP_VERSION}

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/coder-acp-claude-code/package.json ./apps/workers/coder-acp-claude-code/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/coder-acp-claude-code/dist ./apps/workers/coder-acp-claude-code/dist/

# Use existing node user (UID 1000) so claude-code-acp allows bypassPermissions mode
RUN mkdir -p /workspace && chown node:node /workspace
# Copy uv to a shared location accessible by non-root user
RUN cp -r /root/.local/bin/* /usr/local/bin/ 2>/dev/null || true

WORKDIR /app/apps/workers/coder-acp-claude-code

ENV WORKER_NAME=coder-acp-claude-code

USER node
CMD ["node", "dist/index.js"]
