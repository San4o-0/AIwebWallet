/**
 * WalletCore — типізований інтерфейс крипто-ядра гаманця.
 *
 * Реальна імплементація поверх Rust-ядра `crates/wallet-core`, зібраного у
 * WASM (wasm-pack, `pnpm build:wasm` → src/wasm/pkg). Покриває (ТЗ §3, §6):
 *   - генерацію/валідацію BIP-39 seed-фрази (12/24 слова);
 *   - HD-деривацію: EVM m/44'/60'/0'/0/x, Solana m/44'/501'/x'/0',
 *     Bitcoin m/84'/0'/x'/0/0 (Native SegWit);
 *   - підписи secp256k1 (EVM) / ed25519 (Solana);
 *   - шифрування сховища: пароль → Argon2id → AES-256-GCM, zeroize у пам'яті.
 *
 * Архітектура довіри:
 *   - зашифрований vault лежить у chrome.storage.local (див. vault-storage.ts);
 *   - розшифрована seed-фраза живе ТІЛЬКИ в пам'яті background service worker
 *     (сесія з автолоком) — тому всі vault-операції popup делегує в background
 *     через типізовані повідомлення (messaging.ts);
 *   - у popup WASM використовується лише для операцій без секретів, що
 *     персистяться: генерація/валідація мнемоніки під час онбордингу.
 * Приватні ключі ніколи не залишають WASM-пам'ять background; цей інтерфейс
 * оперує лише публічними даними та готовими підписами.
 */
import { i18n, localizeError } from '../i18n';
import type { Chain } from './chains';
import {
  MessageType,
  type PublicAccount,
  type RestoreErrorCode,
  type VaultResult,
  type WalletsState,
} from './messaging';
import { sendToBackground } from './runtime';
import { hasAnyVault, listVaultRecords, nextDefaultWalletName } from './vault-storage';
import { loadWalletCoreWasm, toWasmError } from '../wasm';

export type { PublicAccount, RestoreErrorCode, WalletsState, WalletSummary } from './messaging';

/**
 * Типізована помилка відновлення пароля seed-фразою: UI розрізняє коди
 * (напр. 'wallet-mismatch' → пропозиція «Відновити як новий гаманець»).
 */
export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** Непідписана транзакція у JSON-представленні конкретної мережі. */
export interface UnsignedTransaction {
  chain: Chain;
  /** Серіалізований запит транзакції (EVM tx request / Solana message / BTC PSBT). */
  payload: string;
}

export interface WalletCore {
  /** Чи існує хоч один зашифрований гаманець на цьому пристрої. */
  hasWallet(): Promise<boolean>;
  /** Згенерувати нову BIP-39 фразу (12 або 24 слова). Фраза не персиститься. */
  generateMnemonic(wordCount: 12 | 24): Promise<string[]>;
  /**
   * Створити гаманець із фрази та пароля; повертає акаунт index=0.
   * ЗАВЖДИ додає новий незалежний гаманець (не перезаписує наявні) і робить
   * його активним; ім'я за замовчуванням — «Гаманець N».
   */
  createWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount>;
  /** Імпортувати наявну фразу (те саме, що create, але з валідацією checksum). */
  importWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount>;
  /** Розблокувати АКТИВНИЙ гаманець паролем; повертає акаунти або кидає помилку. */
  unlock(password: string): Promise<PublicAccount[]>;
  /**
   * «Забув пароль»: відновити доступ до АКТИВНОГО гаманця його seed-фразою
   * і задати новий пароль. Background верифікує належність фрази (деривовані
   * адреси проти публічних accounts запису) і замінює лише шифротекст у тому
   * самому VaultRecord (id/name/accounts зберігаються), розблоковуючи сесію.
   * Кидає RestoreError із типізованим кодом.
   */
  restorePassword(mnemonic: readonly string[], newPassword: string): Promise<PublicAccount[]>;
  /** Список гаманців (публічні метадані) + id активного. */
  listWallets(): Promise<WalletsState>;
  /**
   * Зробити активним інший гаманець. Сесія блокується (секрети попереднього
   * затираються) — далі потрібен Unlock паролем нового гаманця.
   */
  switchWallet(walletId: string): Promise<WalletsState>;
  renameWallet(walletId: string, name: string): Promise<WalletsState>;
  /**
   * Видалити гаманець назавжди (без seed-фрази його не відновити). Якщо
   * видаляється активний — активним стає перший із решти, сесія блокується.
   */
  removeWallet(walletId: string): Promise<WalletsState>;
  /** Заблокувати: стерти розшифровані ключі з пам'яті (zeroize у WASM). */
  lock(): Promise<void>;
  /** Дериває наступний акаунт з тієї ж seed-фрази (F1.4). */
  deriveAccount(index: number, name: string): Promise<PublicAccount>;
  /** Підписати транзакцію; повертає серіалізовану підписану транзакцію. */
  signTransaction(tx: UnsignedTransaction): Promise<string>;
  /** Підписати повідомлення (personal_sign тощо); повертає підпис hex/base58. */
  signMessage(chain: Chain, message: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Імплементація поверх WASM-ядра (popup-сторона)
// ---------------------------------------------------------------------------

/** Розгортає VaultResult із background у значення або кидає Error для UI. */
function unwrap<T>(result: VaultResult<T> | undefined): T {
  // У Firefox sendMessage може резолвитись undefined, якщо background не
  // відповів (наприклад, упав на старті) — даємо зрозумілу помилку замість
  // TypeError у рендері.
  if (result === undefined) {
    throw new Error(i18n.t('errors.backgroundUnresponsive'));
  }
  // Background повертає помилки i18n-ключами — перекладаємо для UI.
  if (!result.ok) throw new Error(localizeError(result.error));
  return result.value;
}

class WasmWalletCore implements WalletCore {
  async hasWallet(): Promise<boolean> {
    // Читає нову схему `aiwallet:vaults` (з лінивою міграцією старої).
    return hasAnyVault();
  }

  async generateMnemonic(wordCount: 12 | 24): Promise<string[]> {
    const wasm = await loadWalletCoreWasm();
    try {
      // Ентропія з crypto.getRandomValues (getrandom/js) + BIP-39 checksum у Rust.
      return wasm.generateMnemonic(wordCount).split(' ');
    } catch (error) {
      throw toWasmError(error);
    }
  }

  async createWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount> {
    // Дефолтні назви локалізуються у момент створення (persist як текст):
    // «Гаманець N» вільним номером обчислюється з поточного списку записів.
    let walletName: string | undefined;
    try {
      walletName = nextDefaultWalletName(await listVaultRecords(), (n) =>
        i18n.t('wallets.defaultName', { number: n }),
      );
    } catch {
      walletName = undefined; // background підставить власний fallback
    }
    const result = await sendToBackground({
      type: MessageType.VaultCreate,
      mnemonic: mnemonic.join(' '),
      password,
      accountName: i18n.t('wallets.defaultAccountName', { number: 1 }),
      walletName,
    });
    return unwrap(result);
  }

  async importWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount> {
    if (mnemonic.length !== 12 && mnemonic.length !== 24) {
      throw new Error(i18n.t('errors.phraseWordCount'));
    }
    // Швидка перевірка checksum локально (без Argon2id) для миттєвого фідбеку.
    const wasm = await loadWalletCoreWasm();
    if (!wasm.validateMnemonic(mnemonic.join(' '))) {
      throw new Error(i18n.t('errors.invalidMnemonic'));
    }
    return this.createWallet(mnemonic, password);
  }

  async unlock(password: string): Promise<PublicAccount[]> {
    // Argon2id + AES-GCM decrypt виконується у WASM в background; seed-фраза
    // залишається в пам'яті сесії SW і не повертається в popup.
    const result = await sendToBackground({ type: MessageType.VaultUnlock, password });
    return unwrap(result);
  }

  async restorePassword(
    mnemonic: readonly string[],
    newPassword: string,
  ): Promise<PublicAccount[]> {
    // Фраза йде лише в background (пам'ять SW) — ніколи у storage.
    const result = await sendToBackground({
      type: MessageType.RestoreVaultPassword,
      phrase: mnemonic.join(' '),
      newPassword,
    });
    if (result === undefined) {
      throw new RestoreError('internal', i18n.t('errors.backgroundUnresponsive'));
    }
    if (!result.ok) throw new RestoreError(result.code, localizeError(result.error));
    return result.value;
  }

  async lock(): Promise<void> {
    await sendToBackground({ type: MessageType.LockSession });
  }

  async listWallets(): Promise<WalletsState> {
    return unwrap(await sendToBackground({ type: MessageType.ListWallets }));
  }

  async switchWallet(walletId: string): Promise<WalletsState> {
    return unwrap(await sendToBackground({ type: MessageType.SwitchWallet, walletId }));
  }

  async renameWallet(walletId: string, name: string): Promise<WalletsState> {
    return unwrap(await sendToBackground({ type: MessageType.RenameWallet, walletId, name }));
  }

  async removeWallet(walletId: string): Promise<WalletsState> {
    return unwrap(await sendToBackground({ type: MessageType.RemoveWallet, walletId }));
  }

  async deriveAccount(index: number, name: string): Promise<PublicAccount> {
    const result = await sendToBackground({
      type: MessageType.VaultDeriveAccount,
      index,
      name,
    });
    return unwrap(result);
  }

  async signTransaction(tx: UnsignedTransaction): Promise<string> {
    const result = await sendToBackground({
      type: MessageType.VaultSignTransaction,
      chain: tx.chain,
      payload: tx.payload,
      accountIndex: 0,
    });
    return unwrap(result);
  }

  async signMessage(chain: Chain, message: string): Promise<string> {
    const result = await sendToBackground({
      type: MessageType.VaultSignMessage,
      chain,
      message,
      accountIndex: 0,
    });
    return unwrap(result);
  }
}

/** Єдина точка доступу до крипто-ядра (WASM завантажується ліниво). */
export const walletCore: WalletCore = new WasmWalletCore();
