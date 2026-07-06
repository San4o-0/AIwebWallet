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
import type { Chain } from './chains';
import { MessageType, type PublicAccount, type VaultResult } from './messaging';
import { sendToBackground } from './runtime';
import { readEncryptedVault } from './vault-storage';
import { loadWalletCoreWasm, toWasmError } from '../wasm';

export type { PublicAccount } from './messaging';

/** Непідписана транзакція у JSON-представленні конкретної мережі. */
export interface UnsignedTransaction {
  chain: Chain;
  /** Серіалізований запит транзакції (EVM tx request / Solana message / BTC PSBT). */
  payload: string;
}

export interface WalletCore {
  /** Чи існує зашифроване сховище гаманця на цьому пристрої. */
  hasWallet(): Promise<boolean>;
  /** Згенерувати нову BIP-39 фразу (12 або 24 слова). Фраза не персиститься. */
  generateMnemonic(wordCount: 12 | 24): Promise<string[]>;
  /** Створити гаманець із фрази та пароля; повертає акаунт index=0. */
  createWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount>;
  /** Імпортувати наявну фразу (те саме, що create, але з валідацією checksum). */
  importWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount>;
  /** Розблокувати сховище паролем; повертає список акаунтів або кидає помилку. */
  unlock(password: string): Promise<PublicAccount[]>;
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
function unwrap<T>(result: VaultResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

class WasmWalletCore implements WalletCore {
  async hasWallet(): Promise<boolean> {
    return (await readEncryptedVault()) !== null;
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
    const result = await sendToBackground({
      type: MessageType.VaultCreate,
      mnemonic: mnemonic.join(' '),
      password,
      accountName: 'Акаунт 1',
    });
    return unwrap(result);
  }

  async importWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount> {
    if (mnemonic.length !== 12 && mnemonic.length !== 24) {
      throw new Error('Seed-фраза має містити 12 або 24 слова.');
    }
    // Швидка перевірка checksum локально (без Argon2id) для миттєвого фідбеку.
    const wasm = await loadWalletCoreWasm();
    if (!wasm.validateMnemonic(mnemonic.join(' '))) {
      throw new Error('Невірна seed-фраза: слово поза словником BIP-39 або checksum не збігається.');
    }
    return this.createWallet(mnemonic, password);
  }

  async unlock(password: string): Promise<PublicAccount[]> {
    // Argon2id + AES-GCM decrypt виконується у WASM в background; seed-фраза
    // залишається в пам'яті сесії SW і не повертається в popup.
    const result = await sendToBackground({ type: MessageType.VaultUnlock, password });
    return unwrap(result);
  }

  async lock(): Promise<void> {
    await sendToBackground({ type: MessageType.LockSession });
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
