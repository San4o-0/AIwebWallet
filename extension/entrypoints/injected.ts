/**
 * Injected script — виконується в контексті сторінки (MAIN world).
 * Виставляє window.ethereum (EIP-1193), анонсує провайдера за EIP-6963
 * і (у майбутньому) реєструє Solana Wallet Standard.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

import { AiWalletProvider, announceEip6963 } from '@/src/lib/provider';
import { registerSolanaWalletStandard } from '@/src/lib/solana-wallet-standard';

declare global {
  interface Window {
    ethereum?: AiWalletProvider;
  }
}

export default defineUnlistedScript(() => {
  const provider = new AiWalletProvider();

  // Не перетираємо чужий провайдер агресивно — EIP-6963 вирішує конфлікти.
  if (window.ethereum === undefined) {
    try {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: true,
      });
    } catch {
      window.ethereum = provider;
    }
  }

  announceEip6963(provider);
  registerSolanaWalletStandard();
});
