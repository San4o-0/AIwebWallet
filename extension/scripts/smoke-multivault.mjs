/**
 * Smoke-тест multi-vault: стаб extension API + РЕАЛЬНЕ WASM-ядро
 * (crates/wallet-core → src/wasm/pkg, потрібен `pnpm build:wasm`).
 *
 * Сценарій «живого» користувача:
 *   1. існуючий одно-vault гаманець (старі ключі) → міграція;
 *   2. розблокування мігрованого паролем;
 *   3. додати другий гаманець (СВОЯ фраза + СВІЙ пароль);
 *   4. перемкнутись між гаманцями;
 *   5. розблокувати другий (пароль першого НЕ підходить — незалежність);
 *   6. видалити перший → активний другий; дані другого неушкоджені;
 *   7. «забув пароль» (RestoreVaultPassword): чужа фраза → mismatch і нічого
 *      не змінюється; своя фраза → новий шифротекст у ТОМУ САМОМУ записі
 *      (id/name/accounts збережені), старий пароль мертвий, новий працює.
 *
 * Запуск: `node scripts/smoke-multivault.mjs` (з каталогу extension/).
 * Argon2id у WASM повільний — тест триває десятки секунд.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bundleVaultStorage, resetStubStorage, stubStorage } from './test-utils.mjs';
import initWasm, * as wasm from '../src/wasm/pkg/wallet_core.js';

await initWasm({
  module_or_path: await readFile(new URL('../src/wasm/pkg/wallet_core_bg.wasm', import.meta.url)),
});

const { freshModule } = await bundleVaultStorage();

function accountFromMnemonic(mnemonic, name) {
  const addresses = JSON.parse(wasm.deriveAddresses(mnemonic, 0));
  return {
    index: 0,
    name,
    addresses: { evm: addresses.evm, solana: addresses.solana, bitcoin: addresses.bitcoin },
  };
}

// --- 1. Існуючий користувач: старі ключі у сховищі -------------------------
const PASSWORD_1 = 'password-first-1';
const PASSWORD_2 = 'password-second-2';
const mnemonic1 = wasm.generateMnemonic(12);
const account1 = accountFromMnemonic(mnemonic1, 'Акаунт 1');

resetStubStorage();
stubStorage().set('aiwallet:vault', wasm.createVault(mnemonic1, PASSWORD_1, 'Акаунт 1'));
stubStorage().set('aiwallet:accounts', [account1]);
console.log('крок 1: старий одно-vault гаманець підготовлено');

const storage = await freshModule();
const migrated = await storage.listVaultRecords();
assert.equal(migrated.length, 1);
assert.equal(migrated[0].name, 'Гаманець 1');
assert.deepEqual(migrated[0].accounts, [account1], 'акаунти мігрованого збігаються');
assert.equal(await storage.getActiveVaultId(), migrated[0].id);
assert.ok(!stubStorage().has('aiwallet:vault'), 'старі ключі видалено');
console.log('крок 2: міграція пройшла, дані збігаються');

// Розблокування мігрованого (як vaultUnlock у background: активний запис).
{
  const active = await storage.getActiveVaultRecord();
  const data = JSON.parse(wasm.unlockVault(active.vault, PASSWORD_1));
  assert.equal(data.mnemonic, mnemonic1, 'мігрований vault розшифровується старим паролем');
}
console.log('крок 3: мігрований гаманець розблоковано старим паролем');

// --- 2. Додати другий гаманець (як vaultCreate у background) ---------------
const mnemonic2 = wasm.generateMnemonic(12);
const account2 = accountFromMnemonic(mnemonic2, 'Акаунт 1');
const second = await storage.addVaultRecord({
  vault: wasm.createVault(mnemonic2, PASSWORD_2, 'Акаунт 1'),
  accounts: [account2],
});
assert.equal(second.name, 'Гаманець 2', 'автоіменування «Гаманець N»');
assert.equal(await storage.getActiveVaultId(), second.id, 'новий гаманець став активним');
assert.equal((await storage.listVaultRecords()).length, 2, 'перший гаманець НЕ перезаписано');
console.log('крок 4: другий гаманець додано (перший неушкоджений)');

// --- 3. Перемикання (SwitchWallet) -----------------------------------------
const firstId = migrated[0].id;
await storage.setActiveVaultId(firstId);
assert.equal(await storage.getActiveVaultId(), firstId);
await storage.setActiveVaultId(second.id);
assert.equal(await storage.getActiveVaultId(), second.id);
console.log('крок 5: перемикання активного гаманця працює в обидва боки');

// --- 4. Незалежність паролів + розблокування другого -----------------------
{
  const active = await storage.getActiveVaultRecord();
  assert.equal(active.id, second.id);
  assert.throws(
    () => wasm.unlockVault(active.vault, PASSWORD_1),
    'пароль першого гаманця НЕ розшифровує другий',
  );
  const data = JSON.parse(wasm.unlockVault(active.vault, PASSWORD_2));
  assert.equal(data.mnemonic, mnemonic2, 'другий гаманець розблоковано СВОЇМ паролем');
}
console.log('крок 6: паролі незалежні; другий гаманець розблоковано');

// --- 5. Видалити перший ------------------------------------------------------
{
  const nextActive = await storage.removeVaultRecord(firstId);
  assert.equal(nextActive, second.id, 'активним лишився другий');
  const remaining = await storage.listVaultRecords();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, second.id);
  // Дані другого неушкоджені: розшифровується і адреса та сама.
  const data = JSON.parse(wasm.unlockVault(remaining[0].vault, PASSWORD_2));
  assert.equal(data.mnemonic, mnemonic2);
  assert.equal(remaining[0].accounts[0].addresses.evm, account2.addresses.evm);
}
console.log('крок 7: перший гаманець видалено, другий активний і неушкоджений');

// «Рестарт SW»: свіжий контекст бачить той самий стан.
{
  const restarted = await freshModule();
  const vaults = await restarted.listVaultRecords();
  assert.equal(vaults.length, 1);
  assert.equal(await restarted.getActiveVaultId(), second.id);
}
console.log('крок 8: стан переживає рестарт контексту');

// --- 6. «Забув пароль»: відновлення доступу seed-фразою ---------------------
// Повторює послідовність restoreVaultPassword у background: верифікація
// належності фрази (mnemonicOwnsRecord — той самий production-код) →
// createVault з новим паролем → replaceVaultCiphertext у тому самому записі.
const NEW_PASSWORD = 'password-restored-3';
{
  const active = await storage.getActiveVaultRecord();
  assert.equal(active.id, second.id);

  // Чужа (валідна BIP-39) фраза → верифікація належності провалюється,
  // background у цьому разі повертає 'wallet-mismatch' і НІЧОГО не змінює.
  const strangerMnemonic = wasm.generateMnemonic(12);
  assert.ok(wasm.validateMnemonic(strangerMnemonic), 'чужа фраза валідна сама по собі');
  const strangerDerived = JSON.parse(wasm.deriveAddresses(strangerMnemonic, 0));
  assert.equal(
    storage.mnemonicOwnsRecord(strangerDerived, active),
    false,
    'чужа фраза НЕ проходить верифікацію належності (wallet-mismatch)',
  );
  const untouched = await storage.getVaultRecord(active.id);
  assert.equal(untouched.vault, active.vault, 'після mismatch шифротекст неушкоджений');
  console.log('крок 9: чужа фраза відхилена (mismatch), сховище без змін');

  // Своя фраза проходить верифікацію → новий шифротекст у ТОМУ САМОМУ записі.
  const derived = JSON.parse(wasm.deriveAddresses(mnemonic2, 0));
  assert.equal(
    storage.mnemonicOwnsRecord(derived, active),
    true,
    'фраза цього гаманця проходить верифікацію належності',
  );
  const newVault = wasm.createVault(mnemonic2, NEW_PASSWORD, active.accounts[0].name);
  const updated = await storage.replaceVaultCiphertext(active.id, newVault);
  assert.equal(updated.id, active.id, 'id збережено');
  assert.equal(updated.name, active.name, 'назву збережено');
  assert.equal(updated.createdAt, active.createdAt, 'createdAt збережено');
  assert.deepEqual(updated.accounts, active.accounts, 'публічні акаунти збережено');
  assert.notEqual(updated.vault, active.vault, 'шифротекст справді замінено');

  // Заміна лише для наявного id — незнайомий id кидає помилку.
  await assert.rejects(
    storage.replaceVaultCiphertext('no-such-id', newVault),
    /не знайдено/i,
    'replaceVaultCiphertext для невідомого id кидає помилку',
  );

  // Старий пароль мертвий, новий працює, фраза й адреси ті самі.
  const after = await storage.getVaultRecord(active.id);
  assert.throws(
    () => wasm.unlockVault(after.vault, PASSWORD_2),
    'старий пароль більше НЕ розшифровує vault',
  );
  const data = JSON.parse(wasm.unlockVault(after.vault, NEW_PASSWORD));
  assert.equal(data.mnemonic, mnemonic2, 'новий пароль розшифровує ту саму seed-фразу');
  assert.equal(
    after.accounts[0].addresses.evm,
    account2.addresses.evm,
    'адреси після відновлення ті самі',
  );
}
console.log('крок 10: «забув пароль» — новий пароль діє, id/name/адреси збережені\n');

console.log('Smoke multi-vault (стаб storage + реальний WASM) пройшов.');
