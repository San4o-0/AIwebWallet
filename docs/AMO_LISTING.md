# AMO submission — готові тексти

Копіюй у відповідні поля на addons.mozilla.org.
**Файли:** `~/Desktop/argus-firefox.zip` (пакет), `~/Desktop/argus-source.zip` (вихідники).

---

## Name
```
Argus — AI Crypto Wallet
```

## Summary (коротко, ліміт 250 символів)
```
A non-custodial crypto wallet that explains every transaction in plain language and warns you before you sign. Multi-chain balances, risk analysis of approvals, and an AI assistant for your on-chain activity. Your keys never leave your device.
```

## Description (повний опис)

```
Argus is a non-custodial wallet that tells you what you are about to sign.

Most wallets show you hex data and a confirm button. Argus decodes the
transaction, shows the facts — who receives the money, how much, on which
network, and what the fee will be — and only then offers an AI explanation in
plain language. For an ERC-20 transfer it shows the real recipient taken from
the call data, not the token contract address. For an approval it shows the
spender and warns explicitly when the allowance is unlimited.

WHAT IT DOES
• Explains every transaction in plain language before you sign
• Warns about risky operations: unlimited approvals, unverified contracts,
  known scam addresses, phishing origins
• Multi-chain balances in one place: Ethereum, Polygon, BSC, Arbitrum, Base,
  Solana, Bitcoin, TRON
• Transaction history with human-readable descriptions
• Analytics: what you actually spend on gas, by network and by category
• AI chat about your own activity ("how much did I spend on fees this month?")
• Works with dApps as a standard EIP-1193 / EIP-6963 provider
• Interface in 19 languages, including full RTL support

SECURITY
• Non-custodial: your recovery phrase and private keys never leave your device
• The vault is encrypted with Argon2id and AES-256-GCM; private keys are never
  stored at all — they are derived in WebAssembly memory only while signing
• All cryptography is implemented in Rust and compiled to WebAssembly, bundled
  inside the package — no remote code is ever executed
• Sites cannot see your address until you explicitly connect them, and you can
  revoke access at any time
• The backend has no endpoint capable of accepting a key or recovery phrase,
  and an automated test fails the build if one is ever introduced

PRIVACY
Argus asks for your consent before it sends anything. Your public addresses go
to our backend to fetch balances and analyze transactions. AI features are
OPTIONAL and OFF BY DEFAULT — when disabled, nothing is sent to the AI
provider, and explanations fall back to local rule-based templates. We collect
no analytics and no telemetry.

Full privacy policy: https://san4o-0.github.io/AIwebWallet/PRIVACY.html

BETA — PLEASE READ
Argus has not yet undergone an external security audit. Treat it as beta
software: use it with amounts you can afford to lose, and always back up your
recovery phrase. The source code is fully open — verify anything you like:
https://github.com/San4o-0/AIwebWallet
```

## Category
`Privacy & Security` (додатково можна `Other`)

## Tags
```
wallet, crypto, ethereum, bitcoin, solana, ai, security, web3
```

## Privacy Policy URL
```
https://san4o-0.github.io/AIwebWallet/PRIVACY.html
```

## Support email
```
san4ok07@gmail.com
```

## Homepage / Support site
```
https://github.com/San4o-0/AIwebWallet
```

---

## Notes for Reviewer (ВАЖЛИВО — це поле вирішує долю подачі)

Гаманці Mozilla перевіряє прискіпливо (у них із 2025 окремий ризик-скоринг
саме для wallet-розширень). Вставити в поле «Notes to reviewer»:

```
Thank you for reviewing Argus.

SOURCE CODE AND BUILD
The package contains minified JavaScript and a WebAssembly module, so the full
source is attached. Build instructions are in docs/AMO_BUILD.md inside the
source archive. Summary:

  cd extension
  pnpm install
  pnpm build:wasm     # Rust -> WebAssembly (crates/wallet-core)
  pnpm build:icons
  VITE_API_BASE_URL=https://argus-api-t3go.onrender.com/v1 pnpm wxt build -b firefox

Requires Node 22, pnpm 10, Rust 1.96 (with the wasm32-unknown-unknown target)
and clang (secp256k1-sys contains C code that gcc cannot compile for wasm32).
Output: extension/.output/firefox-mv2/ — identical to the submitted package.

WHY WEBASSEMBLY
All cryptography (BIP-39/BIP-32 derivation, secp256k1 and ed25519 signing,
Argon2id + AES-256-GCM vault encryption) is written in Rust and compiled to
WebAssembly. The .wasm file is bundled in the package and loaded from the
extension's own origin — it is never fetched remotely. No remote code is
executed anywhere in the add-on.

NETWORK ACTIVITY
The extension talks to exactly one host, declared in host permissions:
https://argus-api-t3go.onrender.com — our open-source backend
(crates/api-server in the repository). It is used to read public blockchain
state (balances, history, gas prices), to analyze the risk of a transaction
before signing, and to broadcast already-signed transactions. Blockchain nodes
are never contacted directly from the extension.

DATA COLLECTION
Declared via browser_specific_settings.gecko.data_collection_permissions:
  required: financialAndPaymentInfo — public wallet addresses and transaction
            details, sent to the backend. The wallet cannot display balances
            or analyze risk without this.
  optional: personalCommunications — AI features (transaction details and chat
            messages sent to an AI provider). DISABLED BY DEFAULT; the user
            opts in explicitly, and can turn it off again in Settings.

A consent screen is shown before any network request is made. With no consent
the extension issues no requests at all — this is enforced in a single place in
src/lib/api.ts and covered by an automated test (pnpm test:security, section E,
which counts actual fetch calls).

SECRETS NEVER LEAVE THE DEVICE
The recovery phrase is stored only encrypted (Argon2id + AES-256-GCM) in
storage.local. Private keys are never persisted in any form; they are derived
inside WASM memory at signing time and discarded. The decrypted phrase lives
only in background-script memory and is wiped on lock, auto-lock (5 min),
wallet switch and wallet removal. The backend has no endpoint that accepts a
key or a seed phrase, and crates/api-server/tests/security.rs fails the build
if such a field is ever added.

ABOUT THE "UNSAFE ASSIGNMENT TO innerHTML" WARNING
The validator reports innerHTML assignments in chunks/popup-*.js. These come
from React DOM, not from our code — they are React's internal handling of
dangerouslySetInnerHTML, SVG namespaces and element creation, present in every
React application. Our own source contains no innerHTML, outerHTML or
dangerouslySetInnerHTML anywhere; you can verify this with:

  grep -rn "innerHTML\|dangerouslySetInnerHTML\|outerHTML" extension/src extension/entrypoints

which returns nothing. No user-supplied or network-supplied content is ever
injected as HTML: all values (AI explanations, transaction data, dApp origins)
are rendered as React text nodes and therefore escaped.

DAPP PROVIDER
Standard EIP-1193 / EIP-6963 provider. eth_accounts returns an empty array for
sites the user has not connected — the address is never disclosed without
explicit consent. Connected sites are listed in Settings and can be revoked
individually or all at once.

BETA
The add-on has not undergone an external security audit, and this is stated
plainly in the listing description.
```

---

## Порядок подачі

1. https://addons.mozilla.org/developers/ → **Submit a New Add-on**
2. **On this site** (щоб з'явився в каталозі)
3. Завантаж `argus-firefox.zip`
4. На запит про вихідники — завантаж `argus-source.zip`
5. Заповни поля текстами вище
6. **Notes to reviewer** — вставити блок вище (це головне)
7. Submit

**Строки:** зазвичай кілька днів. Гаманці можуть перевіряти довше — це нормально.
