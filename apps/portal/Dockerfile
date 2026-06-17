# Stage 1: Build
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

# Version information (passed as build args, used by Vite at build time)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV GIT_BRANCH=$GIT_BRANCH

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --filter portal

COPY apps/portal/ apps/portal/
RUN pnpm --filter portal build

# --- Dev stage: Vite dev server with HMR ---
FROM builder AS dev
ENV NODE_ENV=development
WORKDIR /app/apps/portal
EXPOSE 80
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "80"]

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/apps/portal/dist /usr/share/nginx/html
COPY apps/portal/nginx.conf /etc/nginx/conf.d/default.conf
# Runtime config generator — the stock nginx entrypoint runs scripts in
# /docker-entrypoint.d/ before starting nginx, so config.js reflects the
# environment's PORTAL_DOCS_BASE_URL on every container start.
COPY apps/portal/docker-entrypoint.sh /docker-entrypoint.d/99-scope-config.sh
RUN chmod +x /docker-entrypoint.d/99-scope-config.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
