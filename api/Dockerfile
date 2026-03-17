# ── Build stage ───────────────────────────────────────────────────────────────
FROM rust:1.85-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Pré-cache des dépendances Cargo
# On copie d'abord uniquement le Cargo.toml, on crée un main vide,
# on compile pour télécharger/compiler toutes les deps, puis on supprime
# les artefacts du faux main pour forcer la recompilation du vrai.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs \
    && cargo build --release \
    && rm -f target/release/deps/burn_streaming_api* target/release/burn-streaming-api \
    && rm -rf src

# Copie du vrai code source et compilation finale
COPY src ./src
RUN cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/burn-streaming-api /usr/local/bin/api

ENV RUST_LOG=info

EXPOSE 3000

CMD ["api"]
