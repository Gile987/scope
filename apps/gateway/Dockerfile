# Build stage
FROM rust:1.88-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
RUN cargo build --release --target x86_64-unknown-linux-musl

# Dev stage: cargo-watch for hot reload
FROM rust:1.88-alpine AS dev
RUN apk add --no-cache musl-dev && cargo install cargo-watch --locked
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
COPY config/ config/
RUN cargo build
EXPOSE 18000 18897
CMD ["cargo", "watch", "-x", "run -- --config /config/proxy.yaml --port 18000 --api-port 18897 --cert-dir /tmp/scope-gateway/certs"]

# Runtime stage
FROM scratch
COPY --from=builder /build/target/x86_64-unknown-linux-musl/release/gateway /gateway
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 18000 18897
ENTRYPOINT ["/gateway", "--config", "/config/proxy.yaml"]
