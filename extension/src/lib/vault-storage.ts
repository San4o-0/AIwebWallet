/**
 * Персистентність гаманців у chrome.storage.local (ТЗ §6), схема multi-vault:
 *
 *  - `aiwallet:vaults` — масив записів VaultRecord: кожен незалежний гаманець
 *    зі СВОЄЮ seed-фразою і СВОЇМ паролем. Поле `vault` — шифротекст
 *    (JSON EncryptedVault з WASM-ядра: Argon2id → AES-256-GCM), `accounts` —
 *    лише ПУБЛІЧНІ метадані (імена + адреси, без секретів).
 *  - `aiwallet:activeVaultId` — id активного гаманця.
 *
 * Міграція зі старої одно-vault схеми (`aiwallet:vault` + `aiwallet:accounts`)
 * виконується ліниво при першому зверненні (ідемпотентно): старий гаманець
 * стає першим записом «Гаманець 1» і активним, старі ключі видаляються.
 *
 * Розшифровані секрети (seed-фрази) сюди НІКОЛИ не пишуться — вони живуть
 * лише в пам'яті сесії background service worker (див. entrypoints/background.ts).
 */
import { browser } from 'wxt/browser';

import type { PublicAccount } from './messaging';

const VAULTS_KEY = 'aiwallet:vaults';
const ACTIVE_ID_KEY = 'aiwallet:activeVaultId';
/** Ключі старої одно-vault схеми — мігруються і видаляються. */
const LEGACY_VAULT_KEY = 'aiwallet:vault';
const LEGACY_ACCOUNTS_KEY = 'aiwallet:accounts';
/** Ключ прадавнього мок-сховища — прибираємо разом із міграцією. */
const LEGACY_MOCK_KEY = 'aiwallet:mock-vault';

/** Запис одного незалежного гаманця у сховищі. */
export interface VaultRecord {
  id: string;
  name: string;
  createdAt: number;
  /** Шифротекст EncryptedVault (JSON із WASM-ядра). Безпечний для storage. */
  vault: string;
  /** Публічні акаунти гаманця (адреси + імена, без секретів). */
  accounts: PublicAccount[];
}

function isVaultRecord(value: unknown): value is VaultRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['createdAt'] === 'number' &&
    typeof record['vault'] === 'string' &&
    Array.isArray(record['accounts'])
  );
}

async function readVaultsRaw(): Promise<VaultRecord[]> {
  const stored = await browser.storage.local.get(VAULTS_KEY);
  const raw: unknown = stored[VAULTS_KEY];
  return Array.isArray(raw) ? raw.filter(isVaultRecord) : [];
}

async function writeVaults(vaults: VaultRecord[]): Promise<void> {
  await browser.storage.local.set({ [VAULTS_KEY]: vaults });
}

async function readActiveIdRaw(): Promise<string | null> {
  const stored = await browser.storage.local.get(ACTIVE_ID_KEY);
  const raw: unknown = stored[ACTIVE_ID_KEY];
  return typeof raw === 'string' ? raw : null;
}

async function writeActiveId(id: string | null): Promise<void> {
  if (id === null) {
    await browser.storage.local.remove(ACTIVE_ID_KEY);
  } else {
    await browser.storage.local.set({ [ACTIVE_ID_KEY]: id });
  }
}

// ---------------------------------------------------------------------------
// Міграція зі старої одно-vault схеми (лінива, ідемпотентна)
// ---------------------------------------------------------------------------

/** Один проміс на контекст, щоб конкурентні виклики не мігрували двічі. */
let migrationPromise: Promise<void> | null = null;

async function runMigration(): Promise<void> {
  const stored = await browser.storage.local.get([LEGACY_VAULT_KEY, LEGACY_ACCOUNTS_KEY]);
  const legacyVault: unknown = stored[LEGACY_VAULT_KEY];
  if (typeof legacyVault !== 'string' || legacyVault.length === 0) return;

  const legacyAccountsRaw: unknown = stored[LEGACY_ACCOUNTS_KEY];
  const legacyAccounts: PublicAccount[] = Array.isArray(legacyAccountsRaw)
    ? (legacyAccountsRaw as PublicAccount[])
    : [];

  const vaults = await readVaultsRaw();
  // Захист від подвійної міграції у дивному стані (нова схема вже містить
  // цей самий шифротекст): просто прибираємо старі ключі.
  if (!vaults.some((record) => record.vault === legacyVault)) {
    const record: VaultRecord = {
      id: crypto.randomUUID(),
      name: 'Гаманець 1',
      createdAt: Date.now(),
      vault: legacyVault,
      accounts: legacyAccounts,
    };
    vaults.push(record);
    await writeVaults(vaults);
    if ((await readActiveIdRaw()) === null) await writeActiveId(record.id);
  }
  await browser.storage.local.remove([LEGACY_VAULT_KEY, LEGACY_ACCOUNTS_KEY, LEGACY_MOCK_KEY]);
}

/**
 * Гарантує, що стара схема мігрована. Викликається кожною публічною
 * операцією; повторні виклики — no-op.
 */
export function ensureMigrated(): Promise<void> {
  migrationPromise ??= runMigration().catch((error: unknown) => {
    // Не кешуємо невдалу міграцію — наступний виклик спробує знову.
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
}

// ---------------------------------------------------------------------------
// Публічний CRUD-інтерфейс (усі операції — після ensureMigrated)
// ---------------------------------------------------------------------------

/** Усі гаманці (після міграції старої схеми, якщо вона була). */
export async function listVaultRecords(): Promise<VaultRecord[]> {
  await ensureMigrated();
  return readVaultsRaw();
}

/** Чи існує хоч один гаманець на цьому пристрої. */
export async function hasAnyVault(): Promise<boolean> {
  return (await listVaultRecords()).length > 0;
}

/**
 * Id активного гаманця. Самовиліковування: якщо збережений id не вказує на
 * наявний запис — активним стає перший із наявних.
 */
export async function getActiveVaultId(): Promise<string | null> {
  const vaults = await listVaultRecords();
  if (vaults.length === 0) return null;
  const activeId = await readActiveIdRaw();
  if (activeId !== null && vaults.some((record) => record.id === activeId)) return activeId;
  const fallbackId = vaults[0]?.id ?? null;
  await writeActiveId(fallbackId);
  return fallbackId;
}

export async function setActiveVaultId(id: string): Promise<void> {
  const vaults = await listVaultRecords();
  if (!vaults.some((record) => record.id === id)) {
    throw new Error('Гаманець не знайдено.');
  }
  await writeActiveId(id);
}

export async function getVaultRecord(id: string): Promise<VaultRecord | null> {
  const vaults = await listVaultRecords();
  return vaults.find((record) => record.id === id) ?? null;
}

/** Активний гаманець або null, якщо гаманців немає. */
export async function getActiveVaultRecord(): Promise<VaultRecord | null> {
  const activeId = await getActiveVaultId();
  return activeId === null ? null : getVaultRecord(activeId);
}

/** Наступне вільне ім'я за замовчуванням: «Гаманець N». */
export function nextDefaultWalletName(vaults: readonly VaultRecord[]): string {
  const taken = new Set(vaults.map((record) => record.name.trim()));
  for (let n = vaults.length + 1; ; n += 1) {
    const candidate = `Гаманець ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Додає НОВИЙ гаманець (ніколи не перезаписує наявні) і робить його активним.
 * `name` порожнє/відсутнє → «Гаманець N».
 */
export async function addVaultRecord(params: {
  vault: string;
  accounts: PublicAccount[];
  name?: string;
}): Promise<VaultRecord> {
  const vaults = await listVaultRecords();
  const trimmed = params.name?.trim() ?? '';
  const record: VaultRecord = {
    id: crypto.randomUUID(),
    name: trimmed.length > 0 ? trimmed : nextDefaultWalletName(vaults),
    createdAt: Date.now(),
    vault: params.vault,
    accounts: params.accounts,
  };
  await writeVaults([...vaults, record]);
  await writeActiveId(record.id);
  return record;
}

/** Деривовані адреси акаунта index=0 (JSON-форма derivation::Addresses без index). */
export interface DerivedAddresses {
  evm: string;
  solana: string;
  bitcoin: string;
}

/**
 * Чи належить seed-фраза САМЕ цьому гаманцю: деривовані з фрази адреси
 * акаунта index=0 порівнюються з ПУБЛІЧНИМИ адресами запису (accounts
 * зберігаються відкрито, тож перевірка не потребує пароля).
 *
 * EVM порівнюється без регістру (EIP-55 checksum-регістр не має значення)
 * і є обов'язковим; Solana/Bitcoin звіряються, лише якщо запис має непорожні
 * значення (захист від старих/часткових записів).
 */
export function mnemonicOwnsRecord(
  derived: DerivedAddresses,
  record: Pick<VaultRecord, 'accounts'>,
): boolean {
  const primary =
    record.accounts.find((account) => account.index === 0) ?? record.accounts[0];
  if (primary === undefined) return false;
  const { evm, solana, bitcoin } = primary.addresses;
  if (evm.length === 0 || evm.toLowerCase() !== derived.evm.toLowerCase()) return false;
  if (solana.length > 0 && solana !== derived.solana) return false;
  if (bitcoin.length > 0 && bitcoin !== derived.bitcoin) return false;
  return true;
}

/**
 * Замінює ЛИШЕ шифротекст гаманця (флоу «забув пароль»: та сама фраза,
 * новий пароль). id, name, createdAt і публічні accounts зберігаються.
 * Повертає оновлений запис.
 */
export async function replaceVaultCiphertext(id: string, vault: string): Promise<VaultRecord> {
  const vaults = await listVaultRecords();
  const current = vaults.find((record) => record.id === id);
  if (current === undefined) throw new Error('Гаманець не знайдено.');
  const updated: VaultRecord = { ...current, vault };
  await writeVaults(vaults.map((record) => (record.id === id ? updated : record)));
  return updated;
}

/** Оновлює публічні акаунти гаманця (після деривації нового акаунта). */
export async function updateVaultAccounts(id: string, accounts: PublicAccount[]): Promise<void> {
  const vaults = await listVaultRecords();
  await writeVaults(vaults.map((record) => (record.id === id ? { ...record, accounts } : record)));
}

export async function renameVaultRecord(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('Назва не може бути порожньою.');
  const vaults = await listVaultRecords();
  if (!vaults.some((record) => record.id === id)) throw new Error('Гаманець не знайдено.');
  await writeVaults(
    vaults.map((record) => (record.id === id ? { ...record, name: trimmed } : record)),
  );
}

/**
 * Видаляє гаманець (шифротекст зникає зі сховища назавжди). Якщо видалено
 * активний — активним стає перший із решти; якщо гаманців не лишилось —
 * активного немає (стан «немає гаманця» → онбординг).
 * Повертає id нового активного гаманця або null.
 */
export async function removeVaultRecord(id: string): Promise<string | null> {
  const vaults = await listVaultRecords();
  const remaining = vaults.filter((record) => record.id !== id);
  if (remaining.length === vaults.length) throw new Error('Гаманець не знайдено.');
  await writeVaults(remaining);
  const activeId = await readActiveIdRaw();
  if (activeId === id || activeId === null) {
    const nextActive = remaining[0]?.id ?? null;
    await writeActiveId(nextActive);
    return nextActive;
  }
  return activeId;
}
