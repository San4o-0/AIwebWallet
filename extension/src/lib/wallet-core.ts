/**
 * WalletCore — типізований інтерфейс крипто-ядра гаманця.
 *
 * ⚠️ УВАГА: тут МОК-імплементація для розробки UI.
 * Реальна імплементація прийде з `crates/wallet-core` (Rust), зібраного у WASM
 * через wasm-pack (артефакт кладеться в extension/wasm/), і покриє (ТЗ §3, §6):
 *   - генерацію/валідацію BIP-39 seed-фрази (12/24 слова);
 *   - HD-деривацію: EVM m/44'/60'/0'/0/x, Solana m/44'/501'/x'/0',
 *     Bitcoin m/84'/0'/x'/0/0 (Native SegWit);
 *   - підписи secp256k1 / ed25519 / ECDSA(BTC);
 *   - шифрування сховища: пароль → Argon2id → AES-256-GCM, zeroize у пам'яті.
 * Приватні ключі ніколи не залишають WASM-пам'ять; цей інтерфейс оперує лише
 * публічними даними та готовими підписами.
 */
import { browser } from 'wxt/browser';

import type { Chain } from './chains';

/** Публічне представлення акаунта — тільки адреси, жодних ключів. */
export interface PublicAccount {
  index: number;
  name: string;
  addresses: {
    evm: string;
    solana: string;
    bitcoin: string;
  };
}

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
// Мок-імплементація (тимчасово, до інтеграції WASM)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'aiwallet:mock-vault';

interface MockVault {
  /** SHA-256 від пароля — ЛИШЕ ДЛЯ МОКА. У WASM-ядрі буде Argon2id + AES-GCM. */
  passwordHash: string;
  accounts: PublicAccount[];
}

const MOCK_ACCOUNT: PublicAccount = {
  index: 0,
  name: 'Акаунт 1',
  addresses: {
    evm: '0x1F9840a85d5aF5bf1D1762F925BDADdC4201F984',
    solana: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    bitcoin: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  },
};

const MOCK_MNEMONIC_12 = [
  'test', 'test', 'test', 'test', 'test', 'test',
  'test', 'test', 'test', 'test', 'test', 'junk',
];

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readVault(): Promise<MockVault | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw: unknown = stored[STORAGE_KEY];
  return typeof raw === 'string' ? (JSON.parse(raw) as MockVault) : null;
}

async function writeVault(vault: MockVault): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: JSON.stringify(vault) });
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

class MockWalletCore implements WalletCore {
  async hasWallet(): Promise<boolean> {
    return (await readVault()) !== null;
  }

  async generateMnemonic(wordCount: 12 | 24): Promise<string[]> {
    // Мок: реальна генерація ентропії + BIP-39 checksum — у crates/wallet-core.
    return wordCount === 12
      ? [...MOCK_MNEMONIC_12]
      : [...MOCK_MNEMONIC_12, ...MOCK_MNEMONIC_12];
  }

  async createWallet(_mnemonic: readonly string[], password: string): Promise<PublicAccount> {
    const vault: MockVault = {
      passwordHash: await sha256Hex(password),
      accounts: [MOCK_ACCOUNT],
    };
    await writeVault(vault);
    return MOCK_ACCOUNT;
  }

  async importWallet(mnemonic: readonly string[], password: string): Promise<PublicAccount> {
    if (mnemonic.length !== 12 && mnemonic.length !== 24) {
      throw new Error('Seed-фраза має містити 12 або 24 слова.');
    }
    return this.createWallet(mnemonic, password);
  }

  async unlock(password: string): Promise<PublicAccount[]> {
    const vault = await readVault();
    if (!vault) throw new Error('Гаманець не створено.');
    if (vault.passwordHash !== (await sha256Hex(password))) {
      throw new Error('Невірний пароль.');
    }
    return vault.accounts;
  }

  async lock(): Promise<void> {
    // Мок: у WASM-ядрі тут zeroize розшифрованих ключів.
  }

  async deriveAccount(index: number, name: string): Promise<PublicAccount> {
    const account: PublicAccount = {
      ...MOCK_ACCOUNT,
      index,
      name,
      addresses: { ...MOCK_ACCOUNT.addresses, evm: `0x${randomHex(20)}` },
    };
    const vault = await readVault();
    if (vault) {
      await writeVault({ ...vault, accounts: [...vault.accounts, account] });
    }
    return account;
  }

  async signTransaction(tx: UnsignedTransaction): Promise<string> {
    // Мок-підпис: реальний піде через secp256k1/ed25519/ECDSA у WASM.
    return `0xmocksigned_${tx.chain}_${randomHex(32)}`;
  }

  async signMessage(_chain: Chain, _message: string): Promise<string> {
    return `0x${randomHex(65)}`;
  }
}

/** Єдина точка доступу до крипто-ядра. Після інтеграції WASM тут буде
 *  ліниве завантаження модуля: `await init(); return new WasmWalletCore();` */
export const walletCore: WalletCore = new MockWalletCore();
