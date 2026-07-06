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
  lang: 'uk' | 'en';
}

export interface ExplainResponse {
  explanation: string;
}

export interface BroadcastRequest {
  chain: Chain;
  signedTx: string;
}

export interface BroadcastResponse {
  txHash: string;
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
