#!/usr/bin/env node
/**
 * Регресійні тести двох критичних інваріантів безпеки (pnpm test:security).
 * Виконуються на РЕАЛЬНОМУ коді модулів (esbuild-бандл зі стабом storage).
 *
 * A. Бекенд НЕ в ланцюзі довіри підпису (src/lib/evm.ts → verifyTxParams):
 *    chain_id із GET /v1/tx/params потрапляє у RLP підписаної транзакції, тож
 *    його підміна (MITM / скомпрометований бекенд) дала б валідний підпис у
 *    ЧУЖІЙ мережі (replay). Клієнт звіряє chain_id із ЛОКАЛЬНОЮ константою
 *    мережі і відмовляє в підписі при розбіжності; комісії/gas/nonce
 *    проходять санітарні межі.
 *
 * B. Дозволи по origin (src/lib/connections.ts): eth_accounts не має віддавати
 *    адресу сайту, який користувач не підключав.
 */
import assert from 'node:assert/strict';

import { bundleModule, resetStubStorage } from './test-utils.mjs';

const evm = await (await bundleModule('src/lib/evm.ts')).freshModule();
const conn = await (await bundleModule('src/lib/connections.ts')).freshModule();

resetStubStorage();

// ===========================================================================
// A. verifyTxParams — бекенд не в ланцюзі довіри підпису
// ===========================================================================

/** Чесна відповідь бекенду для Ethereum (chain_id 1, 30 gwei). */
const honest = {
  chain_id: 1,
  nonce: 3,
  gas_limit_estimate: '21000',
  fees: { standard: { max_fee_per_gas: '30000000000', max_priority_fee_per_gas: '1500000000' } },
};

evm.verifyTxParams('ethereum', honest);
console.log('OK  A1: валідні параметри (ethereum, chain_id=1) прийнято');

// Головний сценарій атаки: MITM підміняє chain_id 1 → 137.
assert.throws(
  () => evm.verifyTxParams('ethereum', { ...honest, chain_id: 137 }),
  /errors\.chainIdMismatch/,
  'підмінений chain_id мусить відхилятись',
);
console.log('OK  A2: підміна chain_id 1→137 → відмова в підписі (errors.chainIdMismatch)');

// Локальні hex-константи реєстру (CHAINS[*].evmChainIdHex) → десяткові id.
for (const [chain, id] of [
  ['ethereum', 1],
  ['polygon', 137],
  ['bsc', 56],
  ['arbitrum', 42161],
  ['base', 8453],
]) {
  evm.verifyTxParams(chain, { ...honest, chain_id: id });
  assert.throws(
    () => evm.verifyTxParams(chain, { ...honest, chain_id: id + 1 }),
    /errors\.chainIdMismatch/,
    `${chain}: сусідній chain_id мусить відхилятись`,
  );
}
console.log('OK  A3: 1/137/56/42161/8453 звіряються з локальним реєстром мереж');

// Абсурдна комісія: 1 ETH за одиницю газу — спалення балансу на gas.
assert.throws(
  () =>
    evm.verifyTxParams('ethereum', {
      ...honest,
      fees: { standard: { max_fee_per_gas: '1000000000000000000', max_priority_fee_per_gas: '1' } },
    }),
  /errors\.feeTooHigh/,
);
console.log('OK  A4: max_fee_per_gas 1e18 wei (1 ETH/gas) → відмова (errors.feeTooHigh)');

// Реальний піковий газ (500 gwei) НЕ відхиляється — межа не заважає роботі.
evm.verifyTxParams('ethereum', {
  ...honest,
  fees: { standard: { max_fee_per_gas: '500000000000', max_priority_fee_per_gas: '2000000000' } },
});
console.log('OK  A5: піковий, але реальний газ 500 gwei проходить (межа — 10 000 gwei)');

// Сміттєві/суперечливі параметри.
for (const [label, bad] of [
  ['priority > max', { fees: { standard: { max_fee_per_gas: '1000', max_priority_fee_per_gas: '9999' } } }],
  ['nonce < 0', { nonce: -1 }],
  ['gas_limit = 0', { gas_limit_estimate: '0' }],
  ['gas_limit > блок-ліміт', { gas_limit_estimate: '999000000' }],
  ['gas_limit не число', { gas_limit_estimate: 'sign-me' }],
]) {
  assert.throws(
    () => evm.verifyTxParams('ethereum', { ...honest, ...bad }),
    /errors\.txParamsInvalid/,
    `${label} мусить відхилятись`,
  );
}
console.log('OK  A6: priority>max, nonce<0, gas 0/завеликий/не-число → errors.txParamsInvalid');

assert.throws(() => evm.verifyTxParams('solana', honest), /errors\.chainNotEvm/);
console.log('OK  A7: не-EVM мережа не приймає EIP-1559 параметри');

// ===========================================================================
// B. Дозволи по origin — eth_accounts не витікає адресу
// ===========================================================================

assert.deepEqual(await conn.listConnectedSites(), []);
assert.equal(await conn.isOriginConnected('https://evil.example'), false);
console.log('OK  B1: чистий стан — жоден origin не підключений');

await conn.addConnectedSite('https://app.uniswap.org', { walletId: 'w1', accountAddress: '0xabc' });
assert.equal(await conn.isOriginConnected('https://app.uniswap.org'), true);
assert.equal(await conn.isOriginConnected('https://evil.example'), false);
console.log('OK  B2: підключено лише схвалений origin (стороннім сайтам — [])');

// Нормалізація не має ані створювати «інший» дозвіл, ані давати спосіб обійти його.
assert.equal(await conn.isOriginConnected('https://APP.Uniswap.org/'), true);
assert.equal(await conn.isOriginConnected('https://app.uniswap.org/swap?x=1'), true);
assert.equal(await conn.isOriginConnected('https://app.uniswap.org.evil.com'), false);
assert.equal(await conn.isOriginConnected('http://app.uniswap.org'), false);
console.log('OK  B3: регістр/шлях — той самий дозвіл; суфікс-домен і http:// — НЕ підключені');

for (const bad of ['null', '', '   ', 'file:///etc/passwd', 'chrome-extension://abcdef']) {
  assert.equal(await conn.isOriginConnected(bad), false, `origin "${bad}" не має проходити`);
}
console.log('OK  B4: opaque/file/chrome-extension origin ніколи не підключені');

const [before] = await conn.listConnectedSites();
await new Promise((resolve) => setTimeout(resolve, 5));
await conn.addConnectedSite('https://app.uniswap.org', { walletId: 'w2', accountAddress: '0xdef' });
const afterReconnect = await conn.listConnectedSites();
assert.equal(afterReconnect.length, 1, 'повторне підключення не має дублювати запис');
assert.equal(afterReconnect[0].connectedAt, before.connectedAt, 'connectedAt зберігається');
assert.equal(afterReconnect[0].walletId, 'w2', 'гаманець оновлюється');
console.log('OK  B5: повторне підключення не дублює запис, зберігає дату, оновлює гаманець');

await conn.addConnectedSite('https://aave.com', { walletId: 'w1', accountAddress: '0xabc' });
assert.equal((await conn.listConnectedSites()).length, 2);
await conn.removeConnectedSite('https://aave.com');
assert.equal(await conn.isOriginConnected('https://aave.com'), false);
assert.equal(await conn.isOriginConnected('https://app.uniswap.org'), true, 'решта лишається');
console.log('OK  B6: «Відключити» ревокує доступ рівно одного сайту');

await conn.addConnectedSite('https://aave.com', { walletId: 'w1', accountAddress: '0xabc' });
await conn.removeAllConnectedSites();
assert.deepEqual(await conn.listConnectedSites(), []);
assert.equal(await conn.isOriginConnected('https://app.uniswap.org'), false);
console.log('OK  B7: «Відключити всі» ревокує доступ усіх сайтів');

console.log('\nТести безпеки пройшли: A (chain_id + комісії) та B (дозволи по origin).');
