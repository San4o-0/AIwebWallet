/**
 * ЗАГЛУШКА: Solana Wallet Standard (ТЗ F3.5).
 *
 * TODO(solana): реалізувати реєстрацію гаманця за Wallet Standard:
 *  - клас Wallet з властивостями version/name/icon/chains/features/accounts;
 *  - features: 'standard:connect', 'standard:events',
 *    'solana:signTransaction', 'solana:signMessage',
 *    'solana:signAndSendTransaction';
 *  - реєстрація через window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', ...))
 *    + обробка 'wallet-standard:app-ready';
 *  - форвардинг у background тим самим postMessage-протоколом, що й EIP-1193
 *    (розширити Eip1193Method → загальний union RPC-методів у messaging.ts);
 *  - підписи ed25519 — через WASM-ядро (crates/wallet-core).
 */
export function registerSolanaWalletStandard(): void {
  // Поки що нічого не робимо — Solana-провайдер з'явиться після інтеграції ядра.
}
