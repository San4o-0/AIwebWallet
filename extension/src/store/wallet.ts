/**
 * Локальний стан popup (Zustand): розблоковано/ні, активний акаунт,
 * список гаманців (multi-vault), простий state-роутер (без react-router).
 */
import { create } from 'zustand';

import { MessageType, type SessionState, type WalletsState } from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';
import { walletCore, type PublicAccount, type WalletSummary } from '@/src/lib/wallet-core';

export type Screen =
  | 'onboarding'
  | 'unlock'
  | 'home'
  | 'send'
  | 'activity'
  | 'receive'
  | 'chat'
  | 'settings'
  | 'approve';

interface WalletStore {
  /** null — ще не перевіряли сховище. */
  hasWallet: boolean | null;
  unlocked: boolean;
  account: PublicAccount | null;
  screen: Screen;

  /** Публічні метадані всіх гаманців (для перемикача та Settings). */
  wallets: WalletSummary[];
  /** Id активного гаманця (той, що розблоковується паролем). */
  activeWalletId: string | null;
  /**
   * Онбординг у режимі «додати гаманець»: без вітальних кроків, наявні
   * гаманці не чіпаються, у нового — власний пароль.
   */
  addingWallet: boolean;

  setScreen: (screen: Screen) => void;
  /** Початкова ініціалізація при відкритті попапа. */
  initialize: () => Promise<void>;
  /** Розблокування паролем; повертає текст помилки або null при успіху. */
  unlock: (password: string) => Promise<string | null>;
  lock: () => Promise<void>;
  /** Завершення онбордингу (створення/імпорт гаманця — початкове або додавання). */
  completeOnboarding: (account: PublicAccount) => Promise<void>;

  /** Перечитати список гаманців із background (після кожної операції). */
  refreshWallets: () => Promise<void>;
  /** Перемкнутись на інший гаманець: сесія блокується → екран Unlock. */
  switchWallet: (walletId: string) => Promise<string | null>;
  /** Перейменувати гаманець; повертає текст помилки або null. */
  renameWallet: (walletId: string, name: string) => Promise<string | null>;
  /** Видалити гаманець назавжди; повертає текст помилки або null. */
  removeWallet: (walletId: string) => Promise<string | null>;
  /** Відкрити онбординг у режимі «додати гаманець». */
  startAddWallet: () => void;
  /** Скасувати додавання і повернутись до Settings. */
  cancelAddWallet: () => void;
}

/** Активний гаманець зі списку (для назви в шапці/Unlock). */
export function findActiveWallet(
  wallets: readonly WalletSummary[],
  activeWalletId: string | null,
): WalletSummary | null {
  return wallets.find((wallet) => wallet.id === activeWalletId) ?? null;
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  hasWallet: null,
  unlocked: false,
  account: null,
  screen: 'unlock',
  wallets: [],
  activeWalletId: null,
  addingWallet: false,

  setScreen: (screen) => set({ screen }),

  initialize: async () => {
    // Захисна ініціалізація: якщо storage або background недоступні (напр.
    // background упав на старті), попап НЕ повинен зависнути на спінері чи
    // впасти в чорний екран — деградуємо до onboarding/unlock з логом причини.
    let hasWallet = false;
    try {
      hasWallet = await walletCore.hasWallet();
    } catch (error) {
      console.error('[aiwallet] Не вдалося прочитати сховище гаманця:', error);
    }
    if (!hasWallet) {
      set({
        hasWallet: false,
        unlocked: false,
        screen: 'onboarding',
        wallets: [],
        activeWalletId: null,
        addingWallet: false,
      });
      return;
    }
    // Список гаманців потрібен і на Unlock (перемикач), і в Settings.
    await get().refreshWallets();
    // Стан сесії живе у background: розшифрована seed-фраза — тільки в його
    // пам'яті, тож пароль не потрібен на кожне відкриття попапа, поки не
    // спрацював автолок (або background-контекст не перезапустився).
    let session: SessionState | undefined;
    try {
      session = await sendToBackground({ type: MessageType.GetSessionState });
    } catch (error) {
      console.error('[aiwallet] Background не відповідає на GetSessionState:', error);
    }
    const sessionAccount = session?.accounts?.[0];
    if (session?.unlocked === true && sessionAccount !== undefined) {
      set({
        hasWallet: true,
        unlocked: true,
        screen: 'home',
        account: get().account ?? sessionAccount,
      });
      return;
    }
    set({ hasWallet: true, unlocked: false, screen: 'unlock' });
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
    set({ unlocked: false, account: null, screen: 'unlock' });
  },

  completeOnboarding: async (account) => {
    // Сесію в background уже розблоковано під час створення vault.
    set({ hasWallet: true, unlocked: true, account, screen: 'home', addingWallet: false });
    await get().refreshWallets();
  },

  refreshWallets: async () => {
    try {
      const state: WalletsState = await walletCore.listWallets();
      set({
        wallets: state.wallets,
        activeWalletId: state.activeId,
        hasWallet: state.wallets.length > 0,
      });
    } catch (error) {
      // Не валимо UI: список залишиться попереднім, лог для діагностики.
      console.error('[aiwallet] Не вдалося отримати список гаманців:', error);
    }
  },

  switchWallet: async (walletId) => {
    // Перемикання на вже активний гаманець — no-op (сесію не блокуємо).
    if (walletId === get().activeWalletId) return null;
    try {
      const state = await walletCore.switchWallet(walletId);
      // Секрети попередньої сесії затерто в background — тільки Unlock
      // паролем нового активного гаманця.
      set({
        wallets: state.wallets,
        activeWalletId: state.activeId,
        unlocked: false,
        account: null,
        screen: 'unlock',
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Не вдалося перемкнути гаманець.';
    }
  },

  renameWallet: async (walletId, name) => {
    try {
      const state = await walletCore.renameWallet(walletId, name);
      set({ wallets: state.wallets, activeWalletId: state.activeId });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Не вдалося перейменувати.';
    }
  },

  removeWallet: async (walletId) => {
    const wasActive = walletId === get().activeWalletId;
    try {
      const state = await walletCore.removeWallet(walletId);
      if (state.wallets.length === 0) {
        // Гаманців не лишилось — повний онбординг.
        set({
          hasWallet: false,
          unlocked: false,
          account: null,
          wallets: [],
          activeWalletId: null,
          screen: 'onboarding',
          addingWallet: false,
        });
        return null;
      }
      set({
        wallets: state.wallets,
        activeWalletId: state.activeId,
        ...(wasActive
          ? { unlocked: false, account: null, screen: 'unlock' as Screen }
          : {}),
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Не вдалося видалити гаманець.';
    }
  },

  startAddWallet: () => set({ addingWallet: true, screen: 'onboarding' }),

  cancelAddWallet: () => set({ addingWallet: false, screen: 'settings' }),
}));
