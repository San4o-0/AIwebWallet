# Build instructions for AMO reviewers

**Add-on:** Argus (`argus@argus.wallet`)

The submitted package contains minified JavaScript and a WebAssembly module,
so these instructions let you reproduce the exact artifact from source.

## Why WebAssembly is present

All cryptography (BIP-39 mnemonic generation, BIP-32 key derivation,
secp256k1/ed25519 signing, Argon2id + AES-256-GCM vault encryption) is written
in Rust and compiled to WebAssembly. The `.wasm` file is **bundled inside the
package** and is never downloaded at runtime — no remote code is executed.

Rust source: `crates/wallet-core/` (see `src/wasm.rs` for the exported bindings).

## Environment

| Tool | Version used |
|---|---|
| Node.js | 22.x |
| pnpm | 10.x |
| Rust | 1.96 (stable) |
| wasm-pack | 0.15 (installed as a devDependency, no global install needed) |
| clang | required — `secp256k1-sys` contains C code that gcc cannot compile for wasm32 |

```bash
# Debian/Ubuntu
sudo apt-get install -y clang
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
corepack enable
```

## Build

```bash
# from the repository root
cd extension
pnpm install                 # runs `wxt prepare` automatically
pnpm build:wasm              # Rust -> WebAssembly (crates/wallet-core)
pnpm build:icons             # rasterizes assets/icon.svg into public/icon/*.png

VITE_API_BASE_URL=https://argus-api-t3go.onrender.com/v1 pnpm wxt build -b firefox
```

Output: `extension/.output/firefox-mv2/` — this is the content of the submitted
zip archive.

> `VITE_API_BASE_URL` is a build-time constant holding the backend base URL. A
> production build **fails** if it is not `https://` — the backend supplies the
> chain id and gas parameters that go into the signed transaction, so a
> cleartext channel would allow an attacker to alter them.

## Verification

```bash
pnpm typecheck        # TypeScript, strict
pnpm check:locales    # 19 locales, key parity
pnpm test:security    # chain-id tampering, origin spoofing, consent gating
pnpm test:vault       # storage migration
pnpm smoke:multivault # end-to-end over the real WASM crypto
```

Rust side (from the repository root):

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```

## Data handling

Declared in the manifest via `browser_specific_settings.gecko.data_collection_permissions`:

- **required:** `financialAndPaymentInfo` — public wallet addresses, balances
  and transaction details are sent to the backend to display balances/history
  and to analyze risk. The wallet cannot function without this.
- **optional:** `personalCommunications` — AI features. **Disabled by default**
  (opt-in); when off, no transaction details or chat messages are sent to the
  AI provider, and explanations fall back to local rule-based templates.

A consent screen is shown before any network request is made; without consent
the extension issues no requests at all.

**Secrets never leave the device.** The seed phrase is stored encrypted
(Argon2id + AES-256-GCM) in `storage.local`; private keys are never persisted
and are derived in WASM memory only while signing. The backend has no endpoint
capable of accepting a key or seed phrase, and an automated test
(`crates/api-server/tests/security.rs`) fails the build if such a field is
introduced.

Privacy policy: see `docs/PRIVACY.md`.
