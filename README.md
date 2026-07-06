# AI Wallet

Non-custodial криптогаманець (браузерне розширення) з AI-помічником.
Повне ТЗ: [TZ.md](TZ.md).

## Структура

- `crates/wallet-core` — криптоядро (BIP-39/32, підпис, шифрування), компілюється нативно та у WASM
- `crates/chain-adapters` — trait `ChainAdapter` + адаптери EVM / Solana / Bitcoin
- `crates/api-server` — бекенд (Axum): баланси, декодування, ризики, AI
- `extension/` — браузерне розширення (WXT + React + TS)

## Запуск

```bash
docker compose up -d          # PostgreSQL + Redis
cargo run -p api-server       # бекенд
cd extension && pnpm i && pnpm dev   # розширення
```
