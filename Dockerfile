# Argus backend (api-server) — multi-stage build.
#
# Розмір має значення на free-tier: релізний профіль у Cargo.toml уже
# оптимізований під розмір (opt-level = "z", lto, strip), а рантайм-образ —
# debian-slim із самим лише бінарником і кореневими сертифікатами.
#
# Порт: сервер читає PORT з env (Render/Fly/Koyeb підставляють свій),
# дефолт 8080. Слухає 0.0.0.0 — інакше PaaS не достукається.

FROM rust:1-slim-bookworm AS builder

# pkg-config/libssl не потрібні: reqwest зібраний на rustls (без OpenSSL).
WORKDIR /app

# Спершу маніфести — щоб шар із залежностями кешувався між збірками.
COPY Cargo.toml Cargo.lock ./
COPY crates/wallet-core/Cargo.toml crates/wallet-core/
COPY crates/chain-adapters/Cargo.toml crates/chain-adapters/
COPY crates/api-server/Cargo.toml crates/api-server/

# Порожні заглушки, щоб cargo зміг зібрати ЛИШЕ залежності.
RUN mkdir -p crates/wallet-core/src crates/chain-adapters/src crates/api-server/src \
    && echo "fn main() {}" > crates/api-server/src/main.rs \
    && touch crates/wallet-core/src/lib.rs crates/chain-adapters/src/lib.rs \
    && cargo build --release -p api-server 2>/dev/null || true

# Тепер справжні джерела.
COPY crates ./crates
# Оновлюємо mtime, щоб cargo не взяв закешовані заглушки.
RUN touch crates/*/src/lib.rs crates/api-server/src/main.rs \
    && cargo build --release -p api-server \
    && strip target/release/api-server

FROM debian:bookworm-slim AS runtime

# ca-certificates — для TLS до RPC-нод, CoinGecko, Etherscan, AI-провайдера.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Непривілейований користувач.
RUN useradd -r -u 10001 argus
USER argus

COPY --from=builder /app/target/release/api-server /usr/local/bin/api-server

ENV PORT=8080
EXPOSE 8080

CMD ["api-server"]
