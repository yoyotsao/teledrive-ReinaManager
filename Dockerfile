FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:web

FROM rust:bookworm AS server
WORKDIR /src
COPY src-tauri ./src-tauri
RUN cargo build --manifest-path src-tauri/Cargo.toml --release -p reina-server --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl libsqlite3-0 tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /src/src-tauri/target/release/reina-server /app/reina-server
COPY --from=web /src/dist-web /app/static
ENV REINA_PORT=8787
ENV REINA_DATA_DIR=/data
ENV REINA_STATIC_DIR=/app/static
ENV TZ=Asia/Taipei
EXPOSE 8787
ENTRYPOINT ["/app/reina-server"]
