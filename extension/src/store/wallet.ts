/**
 * Локальний стан popup (Zustand): розблоковано/ні, активний акаунт,
 * список гаманців (multi-vault), простий state-роутер (без react-router).
 */
import { create } from 'zustand';

import { i18n, localizeUnknownError } from '@/src/i18n';
import { MessageType, type SessionState, type WalletsState } from '@/src/lib/messaging';
import { sendToBackground } from '@/src/lib/runtime';
import {
  RestoreError,
  walletCore,
  type PublicAccount,
  type RestoreErrorCode,
  type WalletSummary,
} from '@/src/lib/wallet-core';

/** Помилка відновлення пароля для UI: код + текст (null — успіх). */
export interface RestoreFailure {
  code: RestoreErrorCode;
  message: string;
}

export type Screen =
  | 'onboarding'
  | 'unlock'
  | 'home'
  | 'send'
  | 'activity'
  | 'receive'
  | 'chat'
  | 'settings'
  /** Дозволи по origin: список підключених dApp + ревокація (з Settings). */
  | 'connections'
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
  /**
   * Флоу «Забули пароль?» з Unlock: повноекранний степер RestoreWallet
   * (пароль не відновлюється — гаманець відновлюється seed-фразою з новим
   * паролем у тому самому записі).
   */
  restoringPassword: boolean;

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

  /** Відкрити флоу «Забули пароль?» (з екрана Unlock). */
  startRestorePassword: () => void;
  /** Скасувати відновлення і повернутись до Unlock. */
  cancelRestorePassword: () => void;
  /**
   * Відновити доступ до активного гаманця seed-фразою + новим паролем.
   * Успіх — сесію розблоковано (Home); повертає null або типізовану помилку.
   */
  restorePassword: (
    mnemonic: readonly string[],
    newPassword: string,
  ) => Promise<RestoreFailure | null>;
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
  restoringPassword: false,

  setScreen: (screen) => set({ screen }),

  initialize: async () => {
    // Захисна ініціалізація: якщо storage або background недоступні (напр.
    // background упав на старті), попап НЕ повинен зависнути на спінері чи
    // впасти в чорний екран — деградуємо до onboarding/unlock з логом причини.
    let hasWallet = false;
    try {
      hasWallet = await walletCore.hasWallet();
    } catch (error) {
      console.error('[aiwallet] Failed to read wallet storage:', error);
    }
    if (!hasWallet) {
      set({
        hasWallet: false,
        unlocked: false,
        screen: 'onboarding',
        wallets: [],
        activeWalletId: null,
        addingWallet: false,
        restoringPassword: false,
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
      console.error('[aiwallet] Background did not answer GetSessionState:', error);
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
      if (account === undefined) return i18n.t('errors.vaultEmpty');
      set({ unlocked: true, account, screen: 'home' });
      return null;
    } catch (error) {
      return localizeUnknownError(error, 'errors.unlockFailed');
    }
  },

  lock: async () => {
    // walletCore.lock() шле LockSession у background — той затирає seed-фразу.
    await walletCore.lock();
    set({ unlocked: false, account: null, screen: 'unlock' });
  },

  completeOnboarding: async (account) => {
    // Сесію в background уже розблоковано під час створення vault.
    set({
      hasWallet: true,
      unlocked: true,
      account,
      screen: 'home',
      addingWallet: false,
      restoringPassword: false,
    });
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
      console.error('[aiwallet] Failed to list wallets:', error);
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
      return localizeUnknownError(error, 'errors.switchWalletFailed');
    }
  },

  renameWallet: async (walletId, name) => {
    try {
      const state = await walletCore.renameWallet(walletId, name);
      set({ wallets: state.wallets, activeWalletId: state.activeId });
      return null;
    } catch (error) {
      return localizeUnknownError(error, 'errors.renameWalletFailed');
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
      return localizeUnknownError(error, 'errors.removeWalletFailed');
    }
  },

  startAddWallet: () => set({ addingWallet: true, screen: 'onboarding' }),

  cancelAddWallet: () => set({ addingWallet: false, screen: 'settings' }),

  startRestorePassword: () => set({ restoringPassword: true }),

  cancelRestorePassword: () => set({ restoringPassword: false, screen: 'unlock' }),

  restorePassword: async (mnemonic, newPassword) => {
    try {
      // Верифікація належності фрази + заміна шифротексту — у background;
      // сесія там уже розблокована при успіху.
      const accounts = await walletCore.restorePassword(mnemonic, newPassword);
      const account = accounts[0];
      if (account === undefined) {
        return { code: 'internal', message: i18n.t('errors.vaultEmpty') };
      }
      set({
        unlocked: true,
        account,
        screen: 'home',
        restoringPassword: false,
      });
      return null;
    } catch (error) {
      if (error instanceof RestoreError) {
        return { code: error.code, message: error.message };
      }
      return {
        code: 'internal',
        message: localizeUnknownError(error, 'errors.restoreFailed'),
      };
    }
  },
}));
