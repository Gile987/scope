# --- Base stage: runtime tools shared by dev and production ---
FROM node:22.22.0-slim AS base

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

# Install system tools for coding agents: Python, uv, git, PowerShell, .NET, Rust
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    git \
    libicu72 \
    && curl -LsSf https://astral.sh/uv/0.10.0/install.sh | sh \
    && ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in amd64) PS_ARCH=x64; DOTNET_ARCH=x64;; arm64) PS_ARCH=arm64; DOTNET_ARCH=arm64;; *) echo "Unsupported arch: $ARCH" && exit 1;; esac \
    && curl -fsSL -o /tmp/powershell.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v7.4.14/powershell-7.4.14-linux-${PS_ARCH}.tar.gz" \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && rm /tmp/powershell.tar.gz \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
    && curl -fsSL -o /tmp/dotnet-sdk.tar.gz \
      "https://dotnetcli.blob.core.windows.net/dotnet/Sdk/8.0.11/dotnet-sdk-8.0.11-linux-${DOTNET_ARCH}.tar.gz" \
    && mkdir -p /opt/dotnet \
    && tar -xzf /tmp/dotnet-sdk.tar.gz -C /opt/dotnet \
    && rm /tmp/dotnet-sdk.tar.gz \
    && chmod +x /opt/dotnet/dotnet \
    && ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:/root/.local/bin:$PATH"

# --- Builder stage: compile TypeScript ---
FROM base AS builder

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
RUN npm install -g @agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_VERSION}

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
FROM base

# Install Claude Code ACP globally
ARG CLAUDE_CODE_ACP_VERSION
RUN test -n "$CLAUDE_CODE_ACP_VERSION" || (echo 'CLAUDE_CODE_ACP_VERSION build-arg is required' && exit 1)
RUN npm install -g @agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_VERSION}

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

# Expose component versions + build metadata at runtime (used by self-registration)
ARG CLAUDE_AGENT_SDK_VERSION
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV CLAUDE_CODE_ACP_VERSION=$CLAUDE_CODE_ACP_VERSION
ENV CLAUDE_AGENT_SDK_VERSION=$CLAUDE_AGENT_SDK_VERSION
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV WORKER_NAME=coder-acp-claude-code

USER node
CMD ["node", "dist/index.js"]
