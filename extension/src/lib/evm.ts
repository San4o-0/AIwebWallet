/**
 * EVM-хелпери для збірки EIP-1559 транзакцій у розширенні:
 *  - реєстр відомих ERC-20 токенів (дзеркало crates/api-server/src/chains.rs);
 *  - точний парсинг десяткових сум у базові одиниці (bigint, без float);
 *  - декодування повідомлень personal_sign (hex від dApp → байти);
 *  - тип параметрів транзакції для WASM signEvmTransaction (усі числа —
 *    рядки, щоб не втрачати точність на межі JS ↔ Rust).
 */
import type { Chain } from './chains';

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
  if (match === null) throw new Error('Некоректна сума.');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`Забагато знаків після коми (максимум ${decimals}).`);
  }
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (base <= 0n) throw new Error('Сума має бути більшою за нуль.');
  return base;
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
