# Build stage — produces a statically-linked musl binary
FROM rust:1.88-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
# Cache dependencies in a separate layer
COPY Cargo.toml Cargo.lock* ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src/ src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    touch src/main.rs && cargo build --release && \
    cp target/release/gateway /usr/local/bin/gateway

# Dev stage: cargo-watch for hot reload (used by docker-compose.dev.yml)
FROM rust:1.88-alpine AS dev
RUN apk add --no-cache musl-dev wget && cargo install cargo-watch --locked
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
COPY config/ config/
EXPOSE 18000 18897
CMD ["cargo", "watch", "-x", "run -- --config /config/proxy.yaml --port 18000 --api-port 18897 --cert-dir /tmp/scope-gateway/certs"]

# Runtime stage — minimal image with just the binary
FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /usr/local/bin/gateway /usr/local/bin/gateway
EXPOSE 18000 18897
ENTRYPOINT ["gateway"]
CMD ["--config", "/config/proxy.yaml"]
