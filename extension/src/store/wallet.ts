/**
 * Локальний стан popup (Zustand): розблоковано/ні, активний акаунт,
 * простий state-роутер (без react-router).
 */
import { create } from 'zustand';

import { MessageType } from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';
import { walletCore, type PublicAccount } from '@/src/lib/wallet-core';

export type Screen =
  | 'onboarding'
  | 'unlock'
  | 'home'
  | 'send'
  | 'activity'
  | 'chat'
  | 'approve';

interface WalletStore {
  /** null — ще не перевіряли сховище. */
  hasWallet: boolean | null;
  unlocked: boolean;
  account: PublicAccount | null;
  screen: Screen;

  setScreen: (screen: Screen) => void;
  /** Початкова ініціалізація при відкритті попапа. */
  initialize: () => Promise<void>;
  /** Розблокування паролем; повертає текст помилки або null при успіху. */
  unlock: (password: string) => Promise<string | null>;
  lock: () => Promise<void>;
  /** Завершення онбордингу (створення/імпорт гаманця). */
  completeOnboarding: (account: PublicAccount) => Promise<void>;
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  hasWallet: null,
  unlocked: false,
  account: null,
  screen: 'unlock',

  setScreen: (screen) => set({ screen }),

  initialize: async () => {
    const hasWallet = await walletCore.hasWallet();
    // Стан сесії живе у background (service worker) — щоб не вимагати пароль
    // на кожне відкриття попапа, поки не спрацював автолок.
    const session = await sendToBackground({ type: MessageType.GetSessionState });
    if (!hasWallet) {
      set({ hasWallet, unlocked: false, screen: 'onboarding' });
      return;
    }
    if (session.unlocked && session.address !== null) {
      // Мок: акаунт відновлюємо з background-сесії лише як адресу.
      // Після інтеграції WASM тут буде повторний unlock ядра з session key.
      const account = get().account;
      set({
        hasWallet,
        unlocked: true,
        screen: 'home',
        account:
          account ?? {
            index: 0,
            name: 'Акаунт 1',
            addresses: { evm: session.address, solana: '', bitcoin: '' },
          },
      });
      return;
    }
    set({ hasWallet, unlocked: false, screen: 'unlock' });
  },

  unlock: async (password) => {
    try {
      const accounts = await walletCore.unlock(password);
      const account = accounts[0];
      if (account === undefined) return 'Сховище порожнє.';
      await sendToBackground({
        type: MessageType.UnlockSession,
        address: account.addresses.evm,
      });
      set({ unlocked: true, account, screen: 'home' });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Не вдалося розблокувати.';
    }
  },

  lock: async () => {
    await walletCore.lock();
    await sendToBackground({ type: MessageType.LockSession });
    set({ unlocked: false, screen: 'unlock' });
  },

  completeOnboarding: async (account) => {
    await sendToBackground({
      type: MessageType.UnlockSession,
      address: account.addresses.evm,
    });
    set({ hasWallet: true, unlocked: true, account, screen: 'home' });
  },
}));
