# Stage 1: Build
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/portal/package.json packages/portal/
RUN pnpm install --frozen-lockfile --filter portal

COPY packages/portal/ packages/portal/
RUN pnpm --filter portal build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/packages/portal/dist /usr/share/nginx/html
COPY packages/portal/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
