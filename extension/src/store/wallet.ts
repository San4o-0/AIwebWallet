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
    // Стан сесії живе у background (service worker): розшифрована seed-фраза —
    // тільки в його пам'яті, тож пароль не потрібен на кожне відкриття попапа,
    // поки не спрацював автолок (або SW не заснув).
    const session = await sendToBackground({ type: MessageType.GetSessionState });
    if (!hasWallet) {
      set({ hasWallet, unlocked: false, screen: 'onboarding' });
      return;
    }
    const sessionAccount = session.accounts[0];
    if (session.unlocked && sessionAccount !== undefined) {
      set({
        hasWallet,
        unlocked: true,
        screen: 'home',
        account: get().account ?? sessionAccount,
      });
      return;
    }
    set({ hasWallet, unlocked: false, screen: 'unlock' });
  },

  unlock: async (password) => {
    try {
      // Розшифрування vault (Argon2id + AES-GCM) відбувається у WASM-ядрі в
      // background; сюди повертаються лише публічні акаунти.
      const accounts = await walletCore.unlock(password);
      const account = accounts[0];
      if (account === undefined) return 'Сховище порожнє.';
      set({ unlocked: true, account, screen: 'home' });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Не вдалося розблокувати.';
    }
  },

  lock: async () => {
    // walletCore.lock() шле LockSession у background — той затирає seed-фразу.
    await walletCore.lock();
    set({ unlocked: false, screen: 'unlock' });
  },

  completeOnboarding: async (account) => {
    // Сесію в background уже розблоковано під час створення vault.
    set({ hasWallet: true, unlocked: true, account, screen: 'home' });
  },
}));
