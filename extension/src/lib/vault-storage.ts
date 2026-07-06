/**
 * Персистентність гаманця у chrome.storage.local (ТЗ §6):
 *
 *  - `aiwallet:vault` — зашифроване сховище (JSON EncryptedVault з WASM-ядра:
 *    Argon2id → AES-256-GCM). Містить seed-фразу; безпечне для storage.
 *  - `aiwallet:accounts` — ПУБЛІЧНІ метадані акаунтів (імена + адреси, без
 *    жодних секретів), щоб деривація нових акаунтів не вимагала повторного
 *    введення пароля для перешифрування vault.
 *
 * Розшифровані секрети (seed-фраза) сюди НІКОЛИ не пишуться — вони живуть
 * лише в пам'яті сесії background service worker (див. entrypoints/background.ts).
 */
import { browser } from 'wxt/browser';

import type { PublicAccount } from './messaging';

const VAULT_KEY = 'aiwallet:vault';
const ACCOUNTS_KEY = 'aiwallet:accounts';
/** Ключ старого мок-сховища — прибираємо при першому реальному записі. */
const LEGACY_MOCK_KEY = 'aiwallet:mock-vault';

/** Прочитати зашифрований vault (JSON-рядок EncryptedVault) або null. */
export async function readEncryptedVault(): Promise<string | null> {
  const stored = await browser.storage.local.get(VAULT_KEY);
  const raw: unknown = stored[VAULT_KEY];
  return typeof raw === 'string' ? raw : null;
}

export async function writeEncryptedVault(vaultJson: string): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: vaultJson });
  await browser.storage.local.remove(LEGACY_MOCK_KEY);
}

export async function readPublicAccounts(): Promise<PublicAccount[]> {
  const stored = await browser.storage.local.get(ACCOUNTS_KEY);
  const raw: unknown = stored[ACCOUNTS_KEY];
  return Array.isArray(raw) ? (raw as PublicAccount[]) : [];
}

export async function writePublicAccounts(accounts: PublicAccount[]): Promise<void> {
  await browser.storage.local.set({ [ACCOUNTS_KEY]: accounts });
}
