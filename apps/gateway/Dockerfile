# Build stage — produces a statically-linked musl binary
FROM rust:1.88-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
# Cache dependencies in a separate layer
COPY apps/gateway/Cargo.toml apps/gateway/Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY apps/gateway/src/ src/
RUN touch src/main.rs && cargo build --release

# Dev stage: cargo-watch for hot reload (used by docker-compose.dev.yml)
FROM rust:1.88-alpine AS dev
RUN apk add --no-cache musl-dev wget && cargo install cargo-watch --locked
WORKDIR /build
COPY apps/gateway/Cargo.toml apps/gateway/Cargo.lock* ./
COPY apps/gateway/src/ src/
COPY apps/gateway/config/ config/
EXPOSE 18000 18897
CMD ["cargo", "watch", "-x", "run -- --config /config/proxy.yaml --port 18000 --api-port 18897 --cert-dir /tmp/scope-gateway/certs"]

# Runtime stage — minimal image with just the binary
FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /build/target/release/gateway /usr/local/bin/gateway
EXPOSE 18000 18897
ENTRYPOINT ["gateway", "--config", "/config/proxy.yaml"]
