/**
 * Node-тест міграції сховища multi-vault (без WASM, стаб browser.storage.local):
 *
 *   1. старі ключі aiwallet:vault + aiwallet:accounts → нова схема
 *      aiwallet:vaults + aiwallet:activeVaultId, дані збігаються;
 *   2. міграція ідемпотентна (повторні виклики і «рестарт контексту»
 *      нічого не ламають і не дублюють);
 *   3. CRUD: додавання з іменуванням «Гаманець N», перейменування,
 *      видалення з перепризначенням активного.
 *
 * Запуск: `node scripts/test-vault-migration.mjs` (з каталогу extension/).
 */
import assert from 'node:assert/strict';

import { bundleVaultStorage, resetStubStorage, stubStorage } from './test-utils.mjs';

const LEGACY_VAULT = JSON.stringify({
  version: 1,
  kdf: 'argon2id',
  salt: 'c2FsdA==',
  nonce: 'bm9uY2U=',
  ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0LWZvci1taWdyYXRpb24tdGVzdA==',
});
const LEGACY_ACCOUNTS = [
  {
    index: 0,
    name: 'Акаунт 1',
    addresses: { evm: '0xAbCd000000000000000000000000000000000001', solana: 'So1', bitcoin: 'bc1q' },
  },
];

function seedLegacy() {
  resetStubStorage();
  stubStorage().set('aiwallet:vault', LEGACY_VAULT);
  stubStorage().set('aiwallet:accounts', structuredClone(LEGACY_ACCOUNTS));
  stubStorage().set('aiwallet:mock-vault', 'ancient');
}

const { freshModule } = await bundleVaultStorage();

// --- 1. Міграція старої схеми --------------------------------------------
{
  seedLegacy();
  const storage = await freshModule();

  const vaults = await storage.listVaultRecords();
  assert.equal(vaults.length, 1, 'старий vault став єдиним записом');
  const [record] = vaults;
  assert.equal(record.name, 'Гаманець 1');
  assert.equal(record.vault, LEGACY_VAULT, 'шифротекст перенесено без змін');
  assert.deepEqual(record.accounts, LEGACY_ACCOUNTS, 'публічні акаунти перенесено');
  assert.match(record.id, /^[0-9a-f-]{36}$/, 'id — UUID');
  assert.equal(typeof record.createdAt, 'number');

  assert.equal(await storage.getActiveVaultId(), record.id, 'мігрований гаманець активний');
  assert.equal(await storage.hasAnyVault(), true);

  assert.ok(!stubStorage().has('aiwallet:vault'), 'старий ключ vault видалено');
  assert.ok(!stubStorage().has('aiwallet:accounts'), 'старий ключ accounts видалено');
  assert.ok(!stubStorage().has('aiwallet:mock-vault'), 'мок-ключ видалено');
  assert.ok(stubStorage().has('aiwallet:vaults'), 'нова схема записана');

  // Повторний виклик у тому ж контексті — no-op.
  const again = await storage.listVaultRecords();
  assert.deepEqual(again, vaults, 'повторне читання не змінює дані');

  // «Рестарт service worker»: свіжий інстанс модуля, той самий storage.
  const restarted = await freshModule();
  const afterRestart = await restarted.listVaultRecords();
  assert.deepEqual(afterRestart, vaults, 'після рестарту контексту — без дублювання');
  assert.equal(await restarted.getActiveVaultId(), record.id);
  console.log('OK  міграція legacy → multi-vault (дані збігаються, ідемпотентно)');
}

// --- 2. Дивний стан: legacy-ключі поруч із новою схемою -------------------
{
  seedLegacy();
  const storage = await freshModule();
  const [migrated] = await storage.listVaultRecords();
  // Повертаємо legacy-ключі, ніби міграцію перервали після запису нової схеми.
  stubStorage().set('aiwallet:vault', LEGACY_VAULT);
  stubStorage().set('aiwallet:accounts', structuredClone(LEGACY_ACCOUNTS));
  const restarted = await freshModule();
  const vaults = await restarted.listVaultRecords();
  assert.equal(vaults.length, 1, 'той самий шифротекст не дублюється');
  assert.equal(vaults[0].id, migrated.id);
  assert.ok(!stubStorage().has('aiwallet:vault'), 'legacy-ключі прибрано повторно');
  console.log('OK  повторна міграція перерваного стану — без дублікатів');
}

// --- 3. Чисте сховище (нового користувача міграція не чіпає) --------------
{
  resetStubStorage();
  const storage = await freshModule();
  assert.equal(await storage.hasAnyVault(), false);
  assert.equal(await storage.getActiveVaultId(), null);
  assert.deepEqual(await storage.listVaultRecords(), []);
  console.log('OK  чисте сховище — стан «немає гаманця»');
}

// --- 4. CRUD поверх нової схеми -------------------------------------------
{
  resetStubStorage();
  const storage = await freshModule();

  const first = await storage.addVaultRecord({ vault: 'cipher-1', accounts: LEGACY_ACCOUNTS });
  assert.equal(first.name, 'Гаманець 1', "ім'я за замовчуванням");
  assert.equal(await storage.getActiveVaultId(), first.id, 'новий гаманець стає активним');

  const second = await storage.addVaultRecord({ vault: 'cipher-2', accounts: [] });
  assert.equal(second.name, 'Гаманець 2');
  assert.equal(await storage.getActiveVaultId(), second.id);

  await storage.renameVaultRecord(first.id, '  Основний  ');
  assert.equal((await storage.getVaultRecord(first.id)).name, 'Основний', 'trim при перейменуванні');
  await assert.rejects(() => storage.renameVaultRecord(first.id, '   '), /порожн/i);
  await assert.rejects(() => storage.renameVaultRecord('no-such-id', 'X'), /не знайдено/i);
  await assert.rejects(() => storage.setActiveVaultId('no-such-id'), /не знайдено/i);

  // Видалення активного → активним стає перший з решти.
  const nextActive = await storage.removeVaultRecord(second.id);
  assert.equal(nextActive, first.id);
  assert.equal(await storage.getActiveVaultId(), first.id);

  // Видалення останнього → стан «немає гаманця».
  assert.equal(await storage.removeVaultRecord(first.id), null);
  assert.equal(await storage.hasAnyVault(), false);
  assert.equal(await storage.getActiveVaultId(), null);
  console.log('OK  CRUD: іменування «Гаманець N», rename, remove з перепризначенням');
}

// --- 5. Самовиліковування битого activeVaultId ----------------------------
{
  resetStubStorage();
  const storage = await freshModule();
  const record = await storage.addVaultRecord({ vault: 'cipher-x', accounts: [] });
  stubStorage().set('aiwallet:activeVaultId', 'dangling-id');
  assert.equal(await storage.getActiveVaultId(), record.id, 'битий id → перший наявний');
  console.log('OK  самовиліковування activeVaultId');
}

console.log('\nУсі тести міграції сховища пройшли.');
