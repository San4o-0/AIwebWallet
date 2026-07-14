<div align="center">

<img src="extension/assets/icon.svg" width="96" alt="Argus">

# Argus

**A non-custodial crypto wallet that tells you what you are about to sign.**

Most wallets show you hex data and a confirm button. Argus decodes the
transaction, shows the facts, and explains them in plain language — before you
sign.

[**Install for Firefox →**](https://addons.mozilla.org/firefox/addon/argus-ai-wallet)
· [Privacy Policy](https://san4o-0.github.io/AIwebWallet/PRIVACY.html)

</div>

---

## What it does

**Explains every transaction before you sign it.** Argus decodes the call data
and shows what actually happens: who receives the money, how much, on which
network, and what the fee will be. For an ERC-20 transfer it shows the *real
recipient taken from the call data* — not the token contract address, which is
what most wallets display. For an approval it shows the spender and warns
explicitly when the allowance is unlimited.

**Warns you about risk.** Unlimited approvals, unverified contracts, known scam
addresses, phishing origins. The risk engine is rule-based and runs
independently of the AI, so it works even when the AI is switched off.

**Everything else a wallet needs.**

| | |
|---|---|
| **Networks** | Ethereum, Polygon, BSC, Arbitrum, Base, Solana, Bitcoin, TRON |
| **Portfolio** | Aggregated balances and token holdings in one place |
| **History** | Transactions with human-readable descriptions |
| **Analytics** | What you actually spend on gas, by network and by category |
| **AI chat** | Ask about your own activity — answered from real on-chain data, not guesses |
| **dApps** | Standard EIP-1193 / EIP-6963 provider |
| **Languages** | 19, including full right-to-left support |

---

## Security

**Your keys never leave your device.**

- The recovery phrase is stored **encrypted** (Argon2id → AES-256-GCM) in local
  extension storage. Nothing else.
- **Private keys are never stored at all** — not even encrypted. They are derived
  inside WebAssembly memory at the moment of signing and discarded immediately.
- The decrypted phrase lives only in background-script memory and is wiped on
  lock, auto-lock (5 min), wallet switch and wallet removal.
- **The backend has no endpoint capable of accepting a key or a recovery
  phrase** — and an automated test fails the build if such a field is ever
  introduced ([`crates/api-server/tests/security.rs`](crates/api-server/tests/security.rs)).
- All cryptography is written in Rust and compiled to WebAssembly, **bundled
  inside the package**. No remote code is ever executed.
- A compromised backend cannot make you sign a bad transaction: the client
  verifies the returned `chain_id` against its own constant and refuses to sign
  on mismatch, with sanity bounds on gas and fees.
- Websites cannot see your address until you explicitly connect them, and access
  can be revoked at any time.

**Privacy.** Argus asks for consent before it transmits anything. Your public
addresses go to the backend to fetch balances and analyze transactions. **AI
features are optional and off by default** — when disabled, nothing reaches the
AI provider and explanations fall back to local rule-based templates. No
analytics, no telemetry, no ads, no data sales.
Full policy: [PRIVACY.md](docs/PRIVACY.md).

> [!WARNING]
> **Beta software.** Argus has not undergone an external security audit. Use it
> with amounts you can afford to lose, and always back up your recovery phrase.
> Being non-custodial means nobody — including us — can restore your wallet if
> you lose both your password and your phrase.

---

## Architecture

```
Browser extension (WXT + React + TypeScript)
├── Rust → WebAssembly crypto core   keys, derivation, signing, vault encryption
├── Background script                session, auto-lock, dApp request queue
└── Injected provider                EIP-1193 / EIP-6963

          │  HTTPS — public addresses and unsigned transactions only
          ▼

Backend (Rust + Axum)
├── chain-adapters    EVM · Solana · Bitcoin · TRON  (balances, fees, broadcast)
├── risk-engine       rule-based scoring, works without AI
├── indexer           history, categorization, analytics
└── ai-service        explanations and chat (OpenAI-compatible; optional)

          ▼
Public RPC nodes · Etherscan · mempool.space · CoinGecko · AI provider
```

The split is the point: **everything that touches private keys lives in the
WebAssembly core inside the extension.** The backend only ever sees public data.

| Crate | Purpose |
|---|---|
| [`crates/wallet-core`](crates/wallet-core) | BIP-39/32 derivation, secp256k1 + ed25519 signing, EIP-1559 transaction building, Argon2id + AES-256-GCM vault. Compiles natively and to WASM. |
| [`crates/chain-adapters`](crates/chain-adapters) | `ChainAdapter` trait + EVM / Solana / Bitcoin / TRON implementations, with retry and rate limiting. |
| [`crates/api-server`](crates/api-server) | Axum backend: balances, decoding, simulation, risk, analytics, AI. |
| [`extension`](extension) | The extension itself. |

---

## Build from source

**Requirements:** Node 22, pnpm 10, Rust 1.96 (with the `wasm32-unknown-unknown`
target), and `clang` — `secp256k1-sys` contains C code that gcc cannot compile
for wasm32.

```bash
git clone https://github.com/San4o-0/AIwebWallet.git
cd AIwebWallet

# 1. Backend
cargo run -p api-server            # listens on :8080

# 2. Extension (points at your local backend)
cd extension
pnpm install
pnpm build:wasm                    # Rust → WebAssembly
pnpm build:local                   # dev build → .output/firefox-mv2-dev
```

Then load `extension/.output/firefox-mv2-dev/manifest.json` via
`about:debugging` → **This Firefox** → **Load Temporary Add-on**.

**Production build** (requires an HTTPS backend — a cleartext URL makes the
build fail on purpose, because the backend supplies the `chain_id` and gas
parameters that end up inside the signed transaction):

```bash
VITE_API_BASE_URL=https://your-backend/v1 pnpm wxt build -b firefox
```

Deploying your own backend for free: [docs/DEPLOY.md](docs/DEPLOY.md).

### Tests

```bash
cargo test --workspace             # Rust: crypto core, adapters, backend
cargo clippy --workspace --all-targets

cd extension
pnpm typecheck
pnpm check:locales                 # 19 locales, key parity
pnpm test:security                 # chain-id tampering, origin spoofing, consent gating
pnpm test:vault                    # storage migration
pnpm smoke:multivault              # end-to-end over the real WASM crypto
```

---

## License

MIT — see [LICENSE](LICENSE).
