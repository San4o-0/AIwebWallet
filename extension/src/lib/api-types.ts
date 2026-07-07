/**
 * DTO-типи API бекенду (ТЗ §5). Джерело правди — crates/api-server;
 * після стабілізації контрактів варто генерувати типи з OpenAPI.
 */
import type { Chain } from './chains';

// POST /v1/balances -------------------------------------------------------

export interface AddressBook {
  evm: string[];
  solana: string[];
  bitcoin: string[];
}

export interface BalancesRequest {
  addresses: AddressBook;
}

export interface TokenBalance {
  chain: Chain;
  symbol: string;
  name: string;
  /** Кількість у людському форматі (рядок — щоб не втрачати точність). */
  amount: string;
  decimals: number;
  usdPrice: number;
  usdValue: number;
  isNative: boolean;
  contractAddress: string | null;
}

export interface Portfolio {
  totalUsd: number;
  tokens: TokenBalance[];
  updatedAt: string;
}

// GET /v1/history ---------------------------------------------------------

export type TxCategory = 'transfer' | 'swap' | 'approve' | 'mint' | 'dapp';
export type TxDirection = 'in' | 'out' | 'self';
export type TxStatus = 'confirmed' | 'pending' | 'failed';

export interface HistoryEntry {
  id: string;
  chain: Chain;
  hash: string;
  /** Unix ms. */
  timestamp: number;
  category: TxCategory;
  /** Людський опис транзакції (F3.6 / F4.4), мовою користувача. */
  description: string;
  amountUsd: number | null;
  direction: TxDirection;
  status: TxStatus;
}

export interface HistoryResponse {
  items: HistoryEntry[];
  nextCursor: string | null;
}

// POST /v1/tx/* -----------------------------------------------------------

/** EVM-подібний запит транзакції від dApp (частина полів опційна). */
export interface TxRequestDto {
  from: string;
  to: string | null;
  value: string | null;
  data: string | null;
  gas: string | null;
}

export interface DecodeRequest {
  chain: Chain;
  txRequest: TxRequestDto;
}

export interface DecodedTx {
  method: string | null;
  contractName: string | null;
  summary: string;
  params: Record<string, string>;
}

export interface SimulateRequest {
  chain: Chain;
  txRequest: TxRequestDto;
  signer: string;
}

export interface BalanceChange {
  symbol: string;
  amount: string;
  usdValue: number;
}

export interface SimulationResult {
  success: boolean;
  balanceChanges: BalanceChange[];
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskRequest {
  chain: Chain;
  txRequest: TxRequestDto;
  dappOrigin: string;
}

export interface RiskResult {
  level: RiskLevel;
  reasons: string[];
}

export interface ExplainRequest {
  decoded: DecodedTx | null;
  simulation: SimulationResult | null;
  risk: RiskResult | null;
  /** Локаль UI (BCP-47 з реєстру i18n: 'uk', 'en', 'zh-CN', …). */
  lang: string;
}

export interface ExplainResponse {
  explanation: string;
}

/** Поля — snake_case: бекенд серіалізує DTO без rename (crates/api-server/dto.rs). */
export interface BroadcastRequest {
  chain: Chain;
  /** Підписана транзакція: `0x…`-hex (EVM). */
  signed_tx: string;
}

export interface BroadcastResponse {
  tx_hash: string;
  chain: Chain;
  status: string;
}

// GET /v1/tx/params ---------------------------------------------------------

/** Рівень комісії EIP-1559; значення — десяткові рядки у wei. */
export interface FeeTier {
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

/** Параметри для збірки EIP-1559 транзакції (nonce/gas/fees/chain_id). */
export interface TxParams {
  chain: Chain;
  /** Числовий EIP-155 chain id (1 / 137 / 56 / 42161 / 8453). */
  chain_id: number;
  nonce: number;
  /** Рекомендований gas limit (десятковий рядок). */
  gas_limit_estimate: string;
  fees: {
    slow: FeeTier;
    standard: FeeTier;
    fast: FeeTier;
  };
  updated_at: number;
}

// POST /v1/chat (SSE) -----------------------------------------------------

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  addresses: string[];
  /**
   * Локаль UI для відповіді AI. Заповнюється api-клієнтом (streamChat).
   * TODO(бекенд): crates/api-server поки ігнорує поле — врахувати lang
   * у промпті чату.
   */
  lang?: string;
}

/** Формат SSE-події зі стріму /v1/chat: data: {"delta":"..."} … data: [DONE]. */
export interface ChatStreamEvent {
  delta: string;
}

// GET /v1/analytics/* -----------------------------------------------------

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '1y';

export interface FeeAnalytics {
  period: AnalyticsPeriod;
  totalUsd: number;
  byChain: { chain: Chain; usd: number }[];
}

export interface AnalyticsSummary {
  period: AnalyticsPeriod;
  feesUsd: number;
  sentUsd: number;
  receivedUsd: number;
  byChain: { chain: Chain; volumeUsd: number }[];
}

// GET /v1/prices ----------------------------------------------------------

export type PricesResponse = Record<string, { usd: number }>;
