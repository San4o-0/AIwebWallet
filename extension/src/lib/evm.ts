/**
 * EVM-хелпери для збірки EIP-1559 транзакцій у розширенні:
 *  - реєстр відомих ERC-20 токенів (дзеркало crates/api-server/src/chains.rs);
 *  - точний парсинг десяткових сум у базові одиниці (bigint, без float);
 *  - ДЕКОДУВАННЯ ЗАПИТУ dApp (readDappTx/decodeTxIntent): що саме підписує
 *    користувач — сума, СПРАВЖНІЙ отримувач (для ERC-20 — з calldata, а не
 *    адреса контракту), spender і безлімітність approve. Це основа екрана
 *    Approve: рішення ухвалюється за фактами, а не за AI-текстом;
 *  - декодування повідомлень personal_sign (hex від dApp → байти/текст);
 *  - тип параметрів транзакції для WASM signEvmTransaction (усі числа —
 *    рядки, щоб не втрачати точність на межі JS ↔ Rust).
 */
import { CHAINS, evmChainId, type Chain } from './chains';

/** Відомий ERC-20 токен (MVP: стейблкоїни без індексера). */
export interface Erc20Token {
  symbol: string;
  address: string;
  decimals: number;
}

/** Відомі токени за мережею — синхронізовано з бекендом (chains.rs). */
export const KNOWN_ERC20: Partial<Record<Chain, Erc20Token[]>> = {
  ethereum: [
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
    { symbol: 'DAI', address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18 },
  ],
  polygon: [
    { symbol: 'USDC', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
    { symbol: 'USDT', address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 },
  ],
  bsc: [
    { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  ],
  arbitrum: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
    { symbol: 'USDT', address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 },
  ],
  base: [
    { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  ],
};

/** Параметри EIP-1559 транзакції для WASM `signEvmTransaction`. */
export interface Eip1559TxParams {
  chain_id: string;
  nonce: string;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: string;
  /** Відсутнє — деплой контракту. */
  to?: string;
  /** Wei; відсутнє = 0. */
  value?: string;
  /** Hex-calldata (`0x…`); відсутнє = порожньо. */
  data?: string;
}

/** Результат WASM `signEvmTransaction` (JSON). */
export interface SignedEvmTx {
  raw_tx: string;
  tx_hash: string;
}

/** Синтаксична перевірка EVM-адреси. */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Точний парсинг десяткової суми ("1.25") у базові одиниці (bigint).
 * Кидає Error на некоректний ввід або надлишкові знаки після коми.
 */
export function parseAmountToBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  // Помилки — i18n-ключами (модуль бандлиться і в background): попап
  // перекладає їх через localizeError.
  if (match === null) throw new Error('errors.invalidAmount');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`errors.tooManyDecimals|${JSON.stringify({ max: decimals })}`);
  }
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (base <= 0n) throw new Error('errors.amountNotPositive');
  return base;
}

// ---------------------------------------------------------------------------
// Перевірка параметрів транзакції, отриманих із бекенду (GET /v1/tx/params)
// ---------------------------------------------------------------------------

/**
 * Верхня санітарна межа max_fee_per_gas: 10 000 gwei (10^13 wei).
 * Історичні піки газу в Ethereum — сотні gwei; 10 000 gwei лишає величезний
 * запас для реальних сплесків, але відсікає абсурдні значення від
 * скомпрометованого/підміненого бекенду (спалення балансу на комісії).
 */
export const MAX_FEE_PER_GAS_CEILING_WEI = 10_000n * 1_000_000_000n;

/** Верхня санітарна межа gas limit: вище за будь-який реальний блок-ліміт EVM. */
export const MAX_GAS_LIMIT = 60_000_000n;

/**
 * EIP-1474 quantity → bigint: dApp шле числа hex-рядком (`0x5208`), бекенд —
 * десятковим (`21000`). Приймаємо обидва, все інше (порожнє, від'ємне, сміття,
 * `undefined`) — null: краще відмовитись показувати/підписувати, ніж мовчки
 * підставити нуль.
 */
export function parseQuantity(value: string | number | null | undefined): bigint | null {
  try {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) return null;
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Десятковий/hex-рядок або число у bigint; null — не число. */
function toBigInt(value: string | number): bigint | null {
  return parseQuantity(value);
}

/** Мінімальна форма /v1/tx/params, від якої залежить підпис (див. api-types.TxParams). */
export interface UntrustedTxParams {
  chain_id: number;
  nonce: number;
  gas_limit_estimate: string;
  fees: { standard: { max_fee_per_gas: string; max_priority_fee_per_gas: string } };
}

/**
 * КРИТИЧНО ДЛЯ БЕЗПЕКИ. Бекенд — НЕ у ланцюзі довіри підпису: `chain_id`,
 * `nonce` і комісії з GET /v1/tx/params потрапляють у RLP підписаної
 * транзакції. Підмінений `chain_id` дав би валідний підпис у ЧУЖІЙ мережі
 * (replay «того самого» переказу там, де в користувача є кошти), а захмарні
 * комісії — спалення балансу на gas.
 *
 * Тому перед підписом параметри звіряються з ЛОКАЛЬНИМИ константами:
 *  1. `chain_id` мусить точно збігтися з CHAINS[chain].evmChainIdHex (єдина
 *     авторитетна копія — у розширенні, не в мережі);
 *  2. комісії/gas — санітарні верхні межі + інваріант priority ≤ max;
 *  3. nonce — невідʼємне ціле.
 *
 * Кидає Error з i18n-КЛЮЧЕМ (модуль бандлиться і в background, тож переклад
 * робить попап через localizeError). Викликається у єдиній точці входу цих
 * даних — fetchTxParams() у src/lib/api.ts, тобто захищає ОБИДВА шляхи
 * підпису: Send.tsx (переказ користувача) і background.ts (eth_sendTransaction
 * від dApp).
 */
export function verifyTxParams(chain: Chain, params: UntrustedTxParams): void {
  const expected = evmChainId(chain);
  if (expected === null) {
    throw new Error(`errors.chainNotEvm|${JSON.stringify({ chain: CHAINS[chain].label })}`);
  }
  if (params.chain_id !== expected) {
    throw new Error(
      `errors.chainIdMismatch|${JSON.stringify({
        chain: CHAINS[chain].label,
        expected,
        actual: params.chain_id,
      })}`,
    );
  }

  if (!Number.isSafeInteger(params.nonce) || params.nonce < 0) {
    throw new Error('errors.txParamsInvalid');
  }

  const maxFee = toBigInt(params.fees.standard.max_fee_per_gas);
  const priorityFee = toBigInt(params.fees.standard.max_priority_fee_per_gas);
  const gasLimit = toBigInt(params.gas_limit_estimate);
  if (maxFee === null || priorityFee === null || gasLimit === null) {
    throw new Error('errors.txParamsInvalid');
  }
  if (priorityFee > maxFee) throw new Error('errors.txParamsInvalid');
  if (gasLimit === 0n || gasLimit > MAX_GAS_LIMIT) throw new Error('errors.txParamsInvalid');
  if (maxFee > MAX_FEE_PER_GAS_CEILING_WEI) {
    // Показуємо gwei — це одиниця, якою користувач мислить комісію.
    throw new Error(
      `errors.feeTooHigh|${JSON.stringify({
        gwei: (maxFee / 1_000_000_000n).toString(),
        limit: (MAX_FEE_PER_GAS_CEILING_WEI / 1_000_000_000n).toString(),
      })}`,
    );
  }
}

/**
 * Повідомлення personal_sign від dApp: за EIP-1193 — hex (`0x…`), але
 * приймаємо і сирий UTF-8 рядок. Повертає байти повідомлення.
 */
export function decodePersonalSignMessage(message: string): Uint8Array {
  const hex = /^0x([0-9a-fA-F]*)$/.exec(message.trim());
  if (hex !== null) {
    const digits = hex[1] ?? '';
    if (digits.length % 2 === 0) {
      const bytes = new Uint8Array(digits.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
  }
  return new TextEncoder().encode(message);
}

/** Результат декодування повідомлення personal_sign для показу користувачу. */
export interface DecodedSignMessage {
  /** Текст повідомлення (UTF-8) або сирий hex, якщо це не текст. */
  text: string;
  /** true — валідний друкований UTF-8 (показуємо як текст). */
  isText: boolean;
}

/**
 * Hex-повідомлення dApp → людський текст для екрана підпису. Показувати сирий
 * hex там, де є нормальний UTF-8, означає підписувати наосліп; показувати
 * «текст» там, де є керівні символи (спроба сховати частину повідомлення за
 * межами видимого рядка) — гірше, ніж чесний hex. Тому: суворий UTF-8
 * (fatal) + заборона керівних символів, інакше — hex як є.
 */
export function decodePersonalSignText(message: string): DecodedSignMessage {
  const raw = message.trim();
  const bytes = decodePersonalSignMessage(raw);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // \n \r \t — легітимні в підписуваних повідомленнях (SIWE тощо).
    const hasControlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
    if (text.length > 0 && !hasControlChars) return { text, isText: true };
  } catch {
    /* не валідний UTF-8 — показуємо hex */
  }
  return { text: raw, isText: false };
}

// ---------------------------------------------------------------------------
// Декодування запиту транзакції від dApp (екран Approve)
//
// ЧОМУ ЦЕ ТУТ, А НЕ НА БЕКЕНДІ: факти, за якими користувач ухвалює рішення
// (кому, скільки, який дозвіл), мають бути виведені з ТИХ САМИХ байтів, що
// підуть у підпис, і локально — інакше показане на екрані не зобов'язує
// підписане. Бекенд дає ризик і пояснення; факти рахує гаманець.
// ---------------------------------------------------------------------------

/** ERC-20 `transfer(address,uint256)`. */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
/** ERC-20 `approve(address,uint256)`. */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

/**
 * Поріг «безлімітного» дозволу: 2^255. Класична «нескінченність» — uint256-max
 * (2^256−1), але dApp'и шлють і інші величезні константи (uint128-max тощо).
 * Будь-яке значення ≥ 2^255 не може бути витрачене реальним обігом токена
 * (усі емісії на порядки менші), тож це безліміт де-факто — і саме так його
 * треба показувати користувачу, а не «115792089237316195423570985008687907853…».
 */
export const UNLIMITED_APPROVAL_THRESHOLD = 2n ** 255n;

/** Токен реєстру KNOWN_ERC20 за адресою контракту (регістронезалежно). */
export function findKnownErc20(chain: Chain, address: string): Erc20Token | null {
  const needle = address.trim().toLowerCase();
  return (KNOWN_ERC20[chain] ?? []).find((token) => token.address.toLowerCase() === needle) ?? null;
}

/** 32-байтове слово ABI → EVM-адреса; null, якщо старші 12 байтів не нульові. */
function wordToAddress(word: string): string | null {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`;
}

/** Аргументи ABI-виклику з calldata; null — інший селектор або обрізані дані. */
function calldataWords(data: string, selector: string, count: number): string[] | null {
  const raw = data.trim().toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(raw)) return null;
  if (!raw.startsWith(selector)) return null;
  const body = raw.slice(selector.length);
  // Хвіст понад очікувані аргументи ігноруємо (динамічні дані/сміття), але
  // ОБРІЗАНІ дані — ні: з них не можна чесно вивести суму чи отримувача.
  if (body.length < count * 64) return null;
  return Array.from({ length: count }, (_, i) => body.slice(i * 64, (i + 1) * 64));
}

export interface Erc20Transfer {
  /** СПРАВЖНІЙ отримувач токенів (із calldata, не адреса контракту). */
  recipient: string;
  /** Сума у базових одиницях токена. */
  amount: bigint;
}

/** Парсинг calldata ERC-20 `transfer`; null — це не transfer. */
export function parseErc20Transfer(data: string): Erc20Transfer | null {
  const words = calldataWords(data, ERC20_TRANSFER_SELECTOR, 2);
  if (words === null) return null;
  const [recipientWord, amountWord] = words;
  if (recipientWord === undefined || amountWord === undefined) return null;
  const recipient = wordToAddress(recipientWord);
  if (recipient === null) return null;
  return { recipient, amount: BigInt(`0x${amountWord}`) };
}

export interface Erc20Approval {
  /** Кому дається право витрачати токен із гаманця. */
  spender: string;
  amount: bigint;
  /** Дозвіл фактично без обмеження (≥ 2^255). */
  unlimited: boolean;
}

/** Парсинг calldata ERC-20 `approve`; null — це не approve. */
export function parseErc20Approve(data: string): Erc20Approval | null {
  const words = calldataWords(data, ERC20_APPROVE_SELECTOR, 2);
  if (words === null) return null;
  const [spenderWord, amountWord] = words;
  if (spenderWord === undefined || amountWord === undefined) return null;
  const spender = wordToAddress(spenderWord);
  if (spender === null) return null;
  const amount = BigInt(`0x${amountWord}`);
  return { spender, amount, unlimited: amount >= UNLIMITED_APPROVAL_THRESHOLD };
}

/** Обʼєкт транзакції від dApp (`params[0]` у eth_sendTransaction). */
export interface DappTx {
  from: string | null;
  to: string | null;
  /** Wei, hex або десятковий рядок; null — відсутнє (= 0). */
  value: string | null;
  data: string | null;
  /** gas limit від dApp; null — беремо оцінку бекенду. */
  gas: string | null;
}

/** Витягує обʼєкт транзакції з params запиту; null — параметри непридатні. */
export function readDappTx(params: readonly unknown[]): DappTx | null {
  const raw = params[0];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const tx = raw as Record<string, unknown>;
  const field = (key: string): string | null => {
    const value = tx[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    from: field('from'),
    to: field('to'),
    value: field('value'),
    // Деякі dApp'и шлють calldata під ключем `input` (як у JSON-RPC-відповідях).
    data: field('data') ?? field('input'),
    gas: field('gas'),
  };
}

/** Що НАСПРАВДІ робить транзакція (для показу фактів на екрані підпису). */
export type TxIntentKind =
  /** Переказ нативної монети. */
  | 'native'
  /** ERC-20 transfer: гроші йдуть НЕ на `to` (контракт), а на адресу з calldata. */
  | 'erc20-transfer'
  /** ERC-20 approve: право витрачати токен, можливо безлімітне. */
  | 'erc20-approve'
  /** Виклик контракту з невідомим селектором. */
  | 'contract-call'
  /** Деплой контракту (`to` відсутній). */
  | 'contract-deploy';

export interface TxIntent {
  kind: TxIntentKind;
  /**
   * Сторона, яку показуємо користувачу: отримувач переказу (для ERC-20 — з
   * calldata!), spender дозволу або контракт виклику. null — деплой.
   */
  counterparty: string | null;
  /** Контракт, до якого йде виклик (null для нативного переказу/деплою). */
  contract: string | null;
  /** Сума у базових одиницях активу (wei для нативної, base units токена). */
  amount: bigint;
  /** Десяткові знаки активу; null — токен НЕ з реєстру (суму видно лише «сирою»). */
  decimals: number | null;
  /** Тикер активу; null — токен не з реєстру. */
  symbol: string | null;
  /** Безлімітний approve. */
  unlimited: boolean;
  /** 4-байтовий селектор виклику (для невідомих функцій). */
  selector: string | null;
  /** Нативна монета, що йде разом із викликом (wei) — може бути ≠ 0 і в ERC-20. */
  nativeValue: bigint;
}

/**
 * Розбирає запит dApp у факти для екрана підпису. НІКОЛИ не кидає: невідомий
 * виклик — це теж чесний факт («виклик контракту, селектор 0x…»), а не привід
 * показати сирий JSON і сподіватись на AI-текст.
 */
export function decodeTxIntent(chain: Chain, tx: DappTx): TxIntent {
  const nativeSymbol = CHAINS[chain].symbol;
  const nativeValue = parseQuantity(tx.value) ?? 0n;
  const to = tx.to !== null && isEvmAddress(tx.to) ? tx.to.trim().toLowerCase() : null;
  const data = tx.data !== null && tx.data.trim().length > 2 ? tx.data.trim() : null;

  const native: TxIntent = {
    kind: 'native',
    counterparty: to,
    contract: null,
    amount: nativeValue,
    decimals: 18,
    symbol: nativeSymbol,
    unlimited: false,
    selector: null,
    nativeValue,
  };

  if (to === null) {
    return { ...native, kind: 'contract-deploy', counterparty: null, selector: data?.slice(0, 10) ?? null };
  }
  if (data === null) return native;

  const token = findKnownErc20(chain, to);

  const transfer = parseErc20Transfer(data);
  if (transfer !== null) {
    return {
      kind: 'erc20-transfer',
      counterparty: transfer.recipient,
      contract: to,
      amount: transfer.amount,
      decimals: token?.decimals ?? null,
      symbol: token?.symbol ?? null,
      unlimited: false,
      selector: ERC20_TRANSFER_SELECTOR,
      nativeValue,
    };
  }

  const approval = parseErc20Approve(data);
  if (approval !== null) {
    return {
      kind: 'erc20-approve',
      counterparty: approval.spender,
      contract: to,
      amount: approval.amount,
      decimals: token?.decimals ?? null,
      symbol: token?.symbol ?? null,
      unlimited: approval.unlimited,
      selector: ERC20_APPROVE_SELECTOR,
      nativeValue,
    };
  }

  return {
    kind: 'contract-call',
    counterparty: to,
    contract: to,
    amount: nativeValue,
    decimals: 18,
    symbol: nativeSymbol,
    unlimited: false,
    selector: data.slice(0, 10),
    nativeValue,
  };
}

/**
 * Базові одиниці → людський рядок (BigInt, без float). Ненульова, але надто
 * дрібна сума НЕ округлюється до «0» — показується як «<0.000001», інакше
 * екран брехав би про суму переказу.
 */
export function formatUnits(value: bigint, decimals: number, maxFractionDigits = 6): string {
  if (decimals <= 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const digits = Math.min(maxFractionDigits, decimals);
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, digits)
    .replace(/0+$/, '');
  const sign = negative ? '-' : '';
  if (whole === 0n && fraction === '' && abs > 0n && digits > 0) {
    return `${sign}<0.${'0'.repeat(digits - 1)}1`;
  }
  return fraction.length > 0 ? `${sign}${whole.toString()}.${fraction}` : `${sign}${whole.toString()}`;
}

/** Базові одиниці → number (ТІЛЬКИ для приблизної оцінки в USD, не для підпису). */
export function unitsToNumber(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

/**
 * Стеля комісії транзакції: gas_limit × max_fee_per_gas (wei). Саме цю суму
 * користувач у гіршому випадку заплатить — тож саме її показуємо ДО підпису.
 * null — параметри непридатні (не число).
 */
export function maxFeeWei(gasLimit: string, maxFeePerGas: string): bigint | null {
  const gas = parseQuantity(gasLimit);
  const price = parseQuantity(maxFeePerGas);
  if (gas === null || price === null) return null;
  return gas * price;
}
