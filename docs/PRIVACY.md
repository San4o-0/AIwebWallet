---
title: Argus — Privacy Policy
---

# Argus — Privacy Policy

**Last updated:** 2026-07-13

Argus is a non-custodial cryptocurrency wallet browser extension. This policy explains exactly what data leaves your device, why, and who receives it. We have written it to be specific rather than reassuring: if something is transmitted, it is listed here.

## 1. What never leaves your device

The following are stored **only** in your browser's local extension storage and are **never** transmitted to us or to anyone else:

- **Your secret recovery phrase (seed phrase)** — stored encrypted with Argon2id (memory-hard key derivation) and AES-256-GCM. The encryption key is derived from your password.
- **Your private keys** — never stored at all, not even encrypted. They are derived from the seed phrase in memory only at the moment a transaction is signed, and discarded immediately.
- **Your password** — never stored anywhere, in any form. It is used only to decrypt your vault.
- **The list of websites you have connected to the wallet.**
- **Your interface language preference.**

There is no account, no registration, no email address, and no username. We cannot recover your wallet, and neither can anyone else: if you lose both your password and your recovery phrase, your funds are permanently inaccessible.

## 2. What is transmitted to our backend

To display balances, history and analytics, and to explain and broadcast transactions, the extension sends the following to our backend server:

| Data | Why |
|---|---|
| **Your public wallet addresses** | To read balances, transaction history and fee statistics from public blockchains. |
| **Unsigned transaction details** (recipient, amount, contract call data, network) | To simulate the transaction, assess its risk, and explain it in plain language before you sign. |
| **Signed transactions** | To broadcast them to the blockchain network. A signed transaction contains no private key. |
| **Chat messages you type into the AI assistant** | To answer your questions about your wallet activity. |
| **Your IP address** | Automatically visible to any server you contact. We use it solely for rate limiting (to prevent abuse of the service). It is held in memory only, for a short window, and is not stored in a database or linked to your addresses. |

Public blockchain addresses are pseudonymous, but they are not anonymous: an address can be linked to its entire on-chain history, and, if you disclose it elsewhere, to you. Treat the transmission of your addresses accordingly.

## 3. Third parties who receive data

Our backend passes data to the following services. We do not sell data, we do not share it with data brokers, we do not use it for advertising, and we do not perform any profiling or credit scoring.

| Recipient | What they receive | Why |
|---|---|---|
| **AI provider (OpenAI, or an OpenAI-compatible provider such as Groq)** | Decoded transaction details (method, amounts, addresses involved, risk factors) and the content of your chat messages. | To generate plain-language explanations of transactions and to answer your questions. This is a core function of Argus. |
| **Blockchain RPC providers and explorers** — publicnode (Ethereum, Polygon, BSC, Arbitrum, Base), Solana RPC, TronGrid, mempool.space (Bitcoin), Etherscan | Your public wallet addresses and your signed transactions. | Reading blockchain state and broadcasting transactions is impossible without contacting a blockchain node. |
| **CoinGecko** | Only cryptocurrency identifiers (e.g. "ethereum", "bitcoin"). **No addresses and no personal data.** | To convert balances into fiat values. |

Each of these providers processes data under its own privacy policy. If you do not wish transaction details to be sent to an AI provider, do not use the AI explanation and chat features; the wallet remains fully functional without them (explanations fall back to local rule-based templates).

## 4. What we do not do

- We do **not** collect analytics or telemetry.
- We do **not** track your browsing activity. The extension reads the origin of a website only when that website itself requests a connection to the wallet, and that record stays on your device.
- We do **not** show advertisements.
- We do **not** sell, rent, or trade any data.
- We do **not** create user profiles.

## 5. Retention

Our backend does not maintain a user database. Data is processed to answer the request in front of it. Short-lived in-memory caches exist purely for performance and rate limiting (on the order of seconds to minutes) and are discarded thereafter.

## 6. Your choices

- **Not using the AI features** stops any transmission to the AI provider.
- **Disconnecting a website** (Settings → Connected sites) revokes its access to your address.
- **Uninstalling the extension** removes all locally stored data, including your encrypted vault. Make sure you have your recovery phrase written down first — without it the wallet cannot be restored.

## 7. Security

Your vault is encrypted with Argon2id + AES-256-GCM. Communication with our backend uses HTTPS; production builds of the extension refuse to run against a plaintext (http://) backend. The backend has no endpoint capable of accepting a private key or recovery phrase, and this is enforced by an automated test in our build pipeline.

Argus is open source. You can verify every claim in this document by reading the code.

## 8. Children

Argus is not directed at children under 13, and we do not knowingly collect data from them.

## 9. Changes to this policy

If we change what data is transmitted or who receives it, we will update this policy and surface the change in the extension before the new processing begins.

## 10. Contact

- **Email:** san4ok07@gmail.com
- **Source code:** https://github.com/San4o-0/AIwebWallet
