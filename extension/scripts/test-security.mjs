#!/usr/bin/env node
/**
 * Регресійні тести критичних інваріантів безпеки (pnpm test:security).
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
 *
 * C. Декодування запиту dApp (src/lib/evm.ts): екран підпису мусить показувати
 *    ФАКТИ — справжнього отримувача ERC-20 (з calldata, а не адресу контракту),
 *    суму, spender і безлімітність approve. Помилка тут = користувач бачить
 *    не те, що підписує.
 *
 * D. Черга схвалень (src/lib/approval-queue.ts): вікно показує САМЕ той запит,
 *    що його спричинив (requestId, а не «перший у черзі»); спам вікнами
 *    обмежений; підпис БЕЗ показаної комісії неможливий (blind signing).
 *
 * E. Згода на передачу даних (src/lib/consent.ts → src/lib/api.ts): ДОКИ
 *    користувач не дав згоди, api.ts не робить ЖОДНОГО мережевого запиту —
 *    fetch не викликається взагалі (а не «викликається і скасовується»). Це
 *    вимога Chrome Web Store: явна згода в UI ДО першої передачі даних. AI —
 *    окремий, opt-in дозвіл: без нього /v1/chat і /v1/tx/explain не
 *    викликаються, а пояснення беруться з локальних rule-based шаблонів.
 */
import assert from 'node:assert/strict';

import { bundleModule, resetStubStorage, stubStorage } from './test-utils.mjs';

const evm = await (await bundleModule('src/lib/evm.ts')).freshModule();
const conn = await (await bundleModule('src/lib/connections.ts')).freshModule();
const queue = await (await bundleModule('src/lib/approval-queue.ts')).freshModule();

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

// ===========================================================================
// C. Декодування запиту dApp — екран підпису показує факти, а не сирий JSON
// ===========================================================================

/** ABI-слово: 32 байти з правим вирівнюванням. */
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const VICTIM_SEES = '0x1111111111111111111111111111111111111111'; // отримувач у calldata
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // контракт USDC (реєстр)
const SPENDER = '0x2222222222222222222222222222222222222222';
const MAX_UINT256 = (1n << 256n) - 1n;

// transfer(0x1111…, 1 500 000) — USDC має 6 знаків, отже 1.5 USDC.
const transferData = `0xa9059cbb${word(VICTIM_SEES)}${word('0x16e360')}`;
const transfer = evm.parseErc20Transfer(transferData);
assert.equal(transfer.recipient, VICTIM_SEES, 'отримувач береться з calldata');
assert.equal(transfer.amount, 1_500_000n);
console.log('OK  C1: ERC-20 transfer → справжній отримувач і сума з calldata');

// Ключовий факт: `to` транзакції — це КОНТРАКТ токена, а не отримувач грошей.
// Показати `to` як «кому» = показати не те, що підписується.
const intent = evm.decodeTxIntent('ethereum', {
  from: '0xdead',
  to: USDC,
  value: '0x0',
  data: transferData,
  gas: null,
});
assert.equal(intent.kind, 'erc20-transfer');
assert.equal(intent.counterparty, VICTIM_SEES, 'контрагент = отримувач, а НЕ адреса контракту');
assert.equal(intent.contract, USDC);
assert.equal(intent.symbol, 'USDC');
assert.equal(intent.decimals, 6);
assert.equal(evm.formatUnits(intent.amount, intent.decimals), '1.5');
console.log('OK  C2: to = контракт USDC, але «кому» показується адреса з calldata (1.5 USDC)');

// approve на uint256-max — класичний unlimited (дренаж гаманця «назавжди»).
const unlimitedData = `0x095ea7b3${word(SPENDER)}${word(`0x${MAX_UINT256.toString(16)}`)}`;
const unlimited = evm.parseErc20Approve(unlimitedData);
assert.equal(unlimited.spender, SPENDER);
assert.equal(unlimited.unlimited, true, 'uint256-max мусить детектитись як unlimited');

// 2^255 — межа: усе вище реальний обіг токена не витратить.
const atThreshold = `0x095ea7b3${word(SPENDER)}${word(`0x${(1n << 255n).toString(16)}`)}`;
assert.equal(evm.parseErc20Approve(atThreshold).unlimited, true);

// Скінченний дозвіл (100 USDC) unlimited НЕ вважається — інакше попередження
// знеціниться і його перестануть читати.
const finiteData = `0x095ea7b3${word(SPENDER)}${word('0x5f5e100')}`;
const finite = evm.parseErc20Approve(finiteData);
assert.equal(finite.unlimited, false);
assert.equal(finite.amount, 100_000_000n);
console.log('OK  C3: unlimited approve (uint256-max, 2^255) детектиться; 100 USDC — ні');

const approveIntent = evm.decodeTxIntent('ethereum', {
  from: null,
  to: USDC,
  value: null,
  data: unlimitedData,
  gas: null,
});
assert.equal(approveIntent.kind, 'erc20-approve');
assert.equal(approveIntent.counterparty, SPENDER, 'показуємо spender, а не контракт');
assert.equal(approveIntent.unlimited, true);
console.log('OK  C4: approve → kind=erc20-approve, spender у фактах, unlimited=true');

// Обрізана/сміттєва calldata НЕ має «розпарситись» у щось правдоподібне:
// краще показати «виклик контракту, селектор 0x…», ніж вигадану суму.
for (const bad of [
  '0xa9059cbb', // лише селектор
  `0xa9059cbb${word(VICTIM_SEES)}`, // бракує другого аргументу
  `0xa9059cbb${'ff'.repeat(32)}${word('0x1')}`, // «адреса» з ненульовими старшими байтами
  '0xdeadbeef' + word(VICTIM_SEES) + word('0x1'), // інший селектор
  'not-hex',
]) {
  assert.equal(evm.parseErc20Transfer(bad), null, `calldata "${bad.slice(0, 24)}…" не має парситись`);
}
console.log('OK  C5: обрізана/сміттєва/чужа calldata → null (жодних вигаданих сум)');

const nativeIntent = evm.decodeTxIntent('ethereum', {
  from: null,
  to: VICTIM_SEES,
  value: '0xde0b6b3a7640000', // 1 ETH (hex від dApp)
  data: null,
  gas: null,
});
assert.equal(nativeIntent.kind, 'native');
assert.equal(nativeIntent.symbol, 'ETH');
assert.equal(evm.formatUnits(nativeIntent.amount, 18), '1');

const callIntent = evm.decodeTxIntent('ethereum', {
  from: null,
  to: SPENDER,
  value: '0x0',
  data: '0x38ed1739abcdef',
  gas: null,
});
assert.equal(callIntent.kind, 'contract-call');
assert.equal(callIntent.selector, '0x38ed1739', 'невідомий виклик показує свій селектор');

const deployIntent = evm.decodeTxIntent('ethereum', {
  from: null,
  to: null,
  value: '0x0',
  data: '0x60016002',
  gas: null,
});
assert.equal(deployIntent.kind, 'contract-deploy');
console.log('OK  C6: нативний переказ (wei→ETH), невідомий виклик (селектор), деплой');

// Невідомий токен: decimals немає → суму НЕ можна перерахувати. Показуємо сирі
// одиниці й попереджаємо, а не ділимо навмання на 10^18.
const unknownToken = evm.decodeTxIntent('ethereum', {
  from: null,
  to: '0x9999999999999999999999999999999999999999',
  value: null,
  data: transferData,
  gas: null,
});
assert.equal(unknownToken.kind, 'erc20-transfer');
assert.equal(unknownToken.decimals, null, 'невідомий токен не має вигаданих decimals');
assert.equal(unknownToken.symbol, null);
console.log('OK  C7: токен поза реєстром → decimals/symbol = null (сума лише в сирих одиницях)');

// Ненульова, але дрібна сума не має показуватись як «0» — це брехня про переказ.
assert.equal(evm.formatUnits(1n, 18), '<0.000001');
assert.equal(evm.formatUnits(0n, 18), '0');
assert.equal(evm.formatUnits(1_500_000_000_000_000_000n, 18), '1.5');
console.log('OK  C8: formatUnits — 1 wei → «<0.000001», а не «0»');

// personal_sign: hex → текст, якщо це справді текст.
assert.deepEqual(evm.decodePersonalSignText('0x68656c6c6f'), { text: 'hello', isText: true });
const binary = evm.decodePersonalSignText('0x00ff00ff');
assert.equal(binary.isText, false, 'бінарні дані не видаються за текст');
assert.equal(binary.text, '0x00ff00ff', 'не текст → чесний hex');
console.log('OK  C9: personal_sign — валідний UTF-8 показується текстом, решта — hex');

// Стеля комісії, яку користувач бачить ДО підпису: 21 000 × 30 gwei.
assert.equal(evm.maxFeeWei('21000', '30000000000'), 630_000_000_000_000n);
assert.equal(evm.formatUnits(630_000_000_000_000n, 18), '0.00063');
assert.equal(evm.maxFeeWei('0x5208', '30000000000'), 630_000_000_000_000n, 'hex gas від dApp');
console.log('OK  C10: комісія = gas × max_fee_per_gas (0.00063 ETH), hex від dApp приймається');

// ===========================================================================
// D. Черга схвалень: адресація вікна, ліміти, заборона підпису наосліп
// ===========================================================================

const req = (id, origin, method, params, createdAt) => ({ id, origin, method, params, createdAt });

const pending = [
  req('req-1', 'https://a.example', 'eth_sendTransaction', [{ to: '0xaaa' }], 1),
  req('req-2', 'https://b.example', 'eth_sendTransaction', [{ to: '0xbbb' }], 2),
  req('req-3', 'https://c.example', 'personal_sign', ['0x68690a'], 3),
];

// ГОЛОВНЕ: вікно резолвить САМЕ свій запит. Раніше Approve брав pending[0] —
// найстаріший — тож за ≥2 запитів показував не той, що його спричинив.
assert.equal(queue.selectPendingRequest(pending, 'req-2').id, 'req-2');
assert.equal(queue.selectPendingRequest(pending, 'req-3').id, 'req-3');
assert.notEqual(
  queue.selectPendingRequest(pending, 'req-2').id,
  pending[0].id,
  'вікно НЕ має показувати «перший у черзі» замість свого запиту',
);
console.log('OK  D1: Approve резолвить запит за requestId, а не pending[0]');

// Зниклий/відсутній id — чесний порожній стан, а НЕ чужий запит із черги.
assert.equal(queue.selectPendingRequest(pending, 'req-404'), null);
assert.equal(queue.selectPendingRequest(pending, null), null);
assert.equal(queue.selectPendingRequest(pending, ''), null);
assert.equal(queue.selectPendingRequest([], 'req-1'), null);
console.log('OK  D2: невідомий/порожній requestId → null (порожній стан, не чужий запит)');

// Дедуплікація: той самий запит від того самого сайту — друге вікно нічого не додає.
const dup = queue.screenNewRequest(pending, {
  origin: 'https://a.example',
  method: 'eth_sendTransaction',
  params: [{ to: '0xaaa' }],
});
assert.equal(dup.code, -32005, 'дублікат відхиляється RPC-помилкою');

// Той самий origin, але ІНША транзакція — легітимно, пропускаємо.
assert.equal(
  queue.screenNewRequest(pending, {
    origin: 'https://a.example',
    method: 'eth_sendTransaction',
    params: [{ to: '0xccc' }],
  }),
  null,
);
console.log('OK  D3: ідентичний запит дедуплікується (-32005), інша транзакція проходить');

// Ліміт вікон на origin: без нього сайт завалює екран діалогами.
const spam = [1, 2, 3].map((n) =>
  req(`spam-${n}`, 'https://evil.example', 'eth_sendTransaction', [{ to: `0x${n}` }], n),
);
assert.equal(queue.MAX_PENDING_PER_ORIGIN, 3);
const overLimit = queue.screenNewRequest(spam, {
  origin: 'https://evil.example',
  method: 'eth_sendTransaction',
  params: [{ to: '0x4' }],
});
assert.equal(overLimit.code, -32005, '4-й запит від origin відхиляється');
// Ліміт — ПО ORIGIN: чужий сайт не має страждати від спамера.
assert.equal(
  queue.screenNewRequest(spam, {
    origin: 'https://good.example',
    method: 'eth_sendTransaction',
    params: [{ to: '0x4' }],
  }),
  null,
);
console.log('OK  D4: ≤3 pending на origin (4-й → -32005); ліміт не зачіпає інші сайти');

// --- Снапшот комісій: підписуємо ТЕ, що показали ---

const shownFee = {
  chainId: 1,
  gasLimit: '21000',
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '1500000000',
};
const dappTx = { from: '0xdead', to: VICTIM_SEES, value: '0xde0b6b3a7640000', data: null, gas: null };

// НАЙВАЖЛИВІШЕ: без снапшота підпис неможливий. Раніше background тягнув
// комісії з бекенду вже ПІСЛЯ схвалення — користувач апрував наосліп.
assert.throws(
  () => queue.buildDappTxParams('ethereum', dappTx, undefined, 7),
  /errors\.feeSnapshotMissing/,
  'схвалення без показаної комісії мусить відхилятись',
);
assert.throws(() => queue.verifyFeeSnapshot('ethereum', undefined), /errors\.feeSnapshotMissing/);
console.log('OK  D5: немає снапшота комісій → підпис ЗАБОРОНЕНО (errors.feeSnapshotMissing)');

const built = queue.buildDappTxParams('ethereum', dappTx, shownFee, 7);
assert.equal(built.max_fee_per_gas, shownFee.maxFeePerGas, 'підписуємо ПОКАЗАНУ комісію');
assert.equal(built.max_priority_fee_per_gas, shownFee.maxPriorityFeePerGas);
assert.equal(built.gas_limit, shownFee.gasLimit);
assert.equal(built.chain_id, '1', 'chain_id — зі снапшота, не з мережі');
assert.equal(built.nonce, '7', 'свіжим береться лише nonce');
assert.equal(built.to, VICTIM_SEES);
assert.equal(built.value, '0xde0b6b3a7640000');
// Комісія, яку побачив користувач, збігається з тією, що піде у RLP.
assert.equal(
  evm.maxFeeWei(built.gas_limit, built.max_fee_per_gas),
  evm.maxFeeWei(shownFee.gasLimit, shownFee.maxFeePerGas),
);
console.log('OK  D6: підписані комісії/chain_id = показані; свіжий лише nonce');

// Снапшот приходить із попапа і містить `gas` від dApp — тобто чуже число.
// Він проходить ТІ САМІ перевірки, що й дані з бекенду.
assert.throws(
  () => queue.verifyFeeSnapshot('ethereum', { ...shownFee, chainId: 137 }),
  /errors\.chainIdMismatch/,
  'снапшот із чужим chain_id не приймається навіть від попапа',
);
assert.throws(
  () => queue.verifyFeeSnapshot('ethereum', { ...shownFee, maxFeePerGas: '1000000000000000000' }),
  /errors\.feeTooHigh/,
);
assert.throws(
  () => queue.verifyFeeSnapshot('ethereum', { ...shownFee, gasLimit: '999000000' }),
  /errors\.txParamsInvalid/,
);
assert.throws(() => queue.buildDappTxParams('ethereum', dappTx, shownFee, -1), /errors\.txParamsInvalid/);
console.log('OK  D7: снапшот перевіряється як недовірені дані (chain_id, стеля комісій, gas, nonce)');

// Снапшот потрібен саме там, де підписується транзакція.
assert.equal(queue.requiresFeeSnapshot('eth_sendTransaction'), true);
assert.equal(queue.requiresFeeSnapshot('personal_sign'), false);
assert.equal(queue.requiresFeeSnapshot('eth_requestAccounts'), false);
console.log('OK  D8: снапшот обовʼязковий для eth_sendTransaction (не для підключення/повідомлення)');

// ===========================================================================
// E. Згода на передачу даних: без неї api.ts не робить жодного запиту
// ===========================================================================

const API_BASE_URL = 'https://api.test.example/v1';

// src/lib/consent.ts — той самий модуль, що й у проді (форма запису згоди й
// CONSENT_VERSION беруться з нього, а не дублюються в тесті).
const consentBundle = await bundleModule('src/lib/consent.ts');
const consent = await consentBundle.freshModule();

// api.ts читає base URL із build-time env (vite define у wxt.config.ts) —
// відтворюємо це, інакше модуль не ініціалізується.
const apiBundle = await bundleModule('src/lib/api.ts', {
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(API_BASE_URL),
    'import.meta.env.PROD': 'true',
  },
});

/**
 * Лічильник РЕАЛЬНИХ мережевих викликів: головний свідок у цій секції.
 * Тіла — мінімальні валідні відповіді бекенду (щоб перевірявся саме гейт
 * згоди, а не парсинг).
 */
let fetchCalls = [];
globalThis.fetch = (url, init) => {
  const path = String(url);
  fetchCalls.push(path);
  if (init?.headers?.Accept === 'text/event-stream') {
    return Promise.resolve(new Response('data: [DONE]\n\n', { status: 200 }));
  }
  const body = path.endsWith('/balances')
    ? '{"total_usd":0,"chains":[],"prices_updated_at":0}'
    : '{}';
  return Promise.resolve(
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
};

/**
 * Свіжий інстанс api.ts зі станом згоди, записаним у storage ДО імпорту:
 * кеш згоди в модулі порожній, як після рестарту service worker.
 */
async function apiWithConsent(decision) {
  resetStubStorage();
  if (decision !== null) {
    consent.resetConsentCache();
    await consent.saveConsent(decision);
  }
  fetchCalls = [];
  return apiBundle.freshModule();
}

const ADDRESSES = { addresses: { evm: ['0x1111111111111111111111111111111111111111'] } };
const CHAT_REQ = { messages: [{ role: 'user', content: 'скільки я витратив на комісії?' }] };
const SIGN_REQUEST = req('req-e', 'https://a.example', 'eth_sendTransaction', [
  { from: '0xdead', to: USDC, data: unlimitedData },
], 1);

// --- E1: згоди НЕМАЄ (щойно встановлене розширення) ---

let api = await apiWithConsent(null);

for (const [label, call] of [
  ['/balances', () => api.fetchPortfolio(ADDRESSES)],
  ['/history', () => api.fetchHistory('0x1111111111111111111111111111111111111111')],
  ['/analytics/fees', () => api.fetchFeeAnalytics('0x1111', '30d')],
  ['/analytics/summary', () => api.fetchAnalyticsSummary('0x1111', '30d')],
  ['/prices', () => api.fetchPrices(['ethereum'])],
  ['/tx/decode', () => api.decodeTx({ chain: 'ethereum' })],
  ['/tx/simulate', () => api.simulateTx({ chain: 'ethereum' })],
  ['/tx/risk', () => api.fetchTxRisk({ chain: 'ethereum' })],
  ['/tx/explain', () => api.explainTx({ decoded: null, simulation: null, risk: null, lang: 'uk' })],
  ['/chat', () => api.streamChat(CHAT_REQ).next()],
]) {
  await assert.rejects(
    call,
    /errors\.consent\.(networkDenied|aiDisabled)/,
    `${label} без згоди мусить відхилятись i18n-ключем відмови`,
  );
}
// ГОЛОВНЕ ТВЕРДЖЕННЯ РОЗДІЛУ: жодного байта з пристрою.
assert.deepEqual(fetchCalls, [], 'без згоди fetch не має викликатись ЖОДНОГО разу');
console.log('OK  E1: без згоди — 10 ендпоінтів відмовлено, fetch не викликано жодного разу');

// /tx/params і /tx/broadcast — критичні (їх кличе background). Теж мовчать.
await assert.rejects(
  () => api.fetchTxParams('ethereum', '0xdead'),
  /errors\.api\.txParamsUnavailable|errors\.consent\.networkDenied/,
);
await assert.rejects(
  () => api.broadcastTx({ chain: 'ethereum', signed_tx: '0x02f8' }),
  /errors\.api\.broadcastUnavailable|errors\.consent\.networkDenied/,
);
assert.deepEqual(fetchCalls, [], 'підпис/трансляція без згоди теж не йдуть у мережу');
console.log('OK  E2: /tx/params і /tx/broadcast (background) без згоди — без мережі');

// Ризик і пояснення для екрана підпису ПРАЦЮЮТЬ і без згоди — локально.
// Гаманець не сміє «осліпнути» на unlimited approve через офлайн-режим.
const offlineRisk = await api.assessPendingRequest(SIGN_REQUEST);
assert.equal(offlineRisk.level, 'high', 'unlimited approve лишається high-risk офлайн');
const offlineExplain = await api.explainPendingRequest(SIGN_REQUEST, offlineRisk);
assert.ok(offlineExplain.length > 0, 'пояснення офлайн беруться з локальних шаблонів');
assert.deepEqual(fetchCalls, [], 'локальний скоринг не звертається до бекенду');
console.log('OK  E3: офлайн — ризик (high) і пояснення rule-based, без мережі');

// --- E4: згода на мережу є, AI ВИМКНЕНО (дефолт: opt-in) ---

api = await apiWithConsent({ network: true, ai: false });

await api.fetchPortfolio(ADDRESSES);
await api.fetchHistory('0x1111111111111111111111111111111111111111');
await api.fetchTxRisk({ chain: 'ethereum' });
assert.equal(fetchCalls.length, 3, 'зі згодою фінансові/ризикові ендпоінти працюють');
assert.ok(fetchCalls.every((url) => url.startsWith(API_BASE_URL)), 'запити йдуть лише на наш бекенд');
console.log('OK  E4: зі згодою /balances, /history, /tx/risk (rule-based) працюють');

// AI-ендпоінти лишаються закритими: дані не йдуть AI-провайдеру.
const beforeAi = fetchCalls.length;
await assert.rejects(
  () => api.explainTx({ decoded: null, simulation: null, risk: null, lang: 'uk' }),
  /errors\.consent\.aiDisabled/,
);
await assert.rejects(() => api.streamChat(CHAT_REQ).next(), /errors\.consent\.aiDisabled/);
assert.equal(fetchCalls.length, beforeAi, '/tx/explain і /chat з вимкненим AI не йдуть у мережу');
console.log('OK  E5: AI вимкнено → /tx/explain і /chat не викликаються (0 запитів)');

// Пояснення підпису падає на локальні шаблони, а НЕ на /tx/explain.
const ruleBased = await api.explainPendingRequest(SIGN_REQUEST, { level: 'high', reasons: [] });
assert.ok(ruleBased.length > 0);
assert.ok(
  !fetchCalls.some((url) => url.includes('/tx/explain')),
  'з вимкненим AI пояснення НЕ мусить навіть пробувати /tx/explain',
);
console.log('OK  E6: з вимкненим AI пояснення підпису — локальні rule-based шаблони');

// --- E7: AI увімкнено явно ---

api = await apiWithConsent({ network: true, ai: true });
await api.streamChat(CHAT_REQ).next();
assert.equal(fetchCalls.length, 1);
assert.ok(fetchCalls[0].endsWith('/chat'), 'увімкнений AI відкриває саме /chat');
console.log('OK  E7: AI увімкнено → /chat викликається (явний opt-in користувача)');

// --- E8: AI без згоди на мережу неможливий (суперечливий стан не зберігається) ---

api = await apiWithConsent({ network: false, ai: true });
await assert.rejects(() => api.streamChat(CHAT_REQ).next(), /errors\.consent\./);
await assert.rejects(() => api.fetchPortfolio(ADDRESSES), /errors\.consent\.networkDenied/);
assert.deepEqual(fetchCalls, [], 'ai:true без network:true не дає жодного запиту');
console.log('OK  E8: ai=true при network=false не зберігається як дозвіл — мережі немає');

// --- E9: пошкоджений/застарілий запис згоди → fail-closed ---

resetStubStorage();
stubStorage().set('argus:dataConsent', { version: consent.CONSENT_VERSION + 1, network: true, ai: true });
fetchCalls = [];
api = await apiBundle.freshModule();
await assert.rejects(() => api.fetchPortfolio(ADDRESSES), /errors\.consent\.networkDenied/);
assert.deepEqual(fetchCalls, [], 'згода від ІНШОЇ версії політики не діє (питаємо знову)');

resetStubStorage();
stubStorage().set('argus:dataConsent', 'yes-please');
fetchCalls = [];
api = await apiBundle.freshModule();
await assert.rejects(() => api.fetchPortfolio(ADDRESSES), /errors\.consent\.networkDenied/);
assert.deepEqual(fetchCalls, [], 'пошкоджений запис згоди → fail-closed');
console.log('OK  E9: чужа версія політики / пошкоджений запис → згоди немає (fail-closed)');

resetStubStorage();

console.log(
  '\nТести безпеки пройшли: A (chain_id + комісії), B (дозволи по origin), ' +
    'C (декодування транзакції dApp), D (черга схвалень + снапшот комісій), ' +
    'E (згода на передачу даних: без неї — жодного запиту; AI — окремий opt-in).',
);
