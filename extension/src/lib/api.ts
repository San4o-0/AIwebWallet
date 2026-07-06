/**
 * Типізований клієнт API бекенду (ТЗ §5): http://localhost:8080/v1.
 *
 * Поки бекенд (crates/api-server) у розробці, кожен метод має fallback на
 * мок-дані — гаманець залишається робочим без бекенду (fail-safe, ТЗ §1.2).
 */
import type {
  AnalyticsPeriod,
  AnalyticsSummary,
  BalancesRequest,
  BroadcastRequest,
  BroadcastResponse,
  ChatRequest,
  DecodeRequest,
  DecodedTx,
  ExplainRequest,
  ExplainResponse,
  FeeAnalytics,
  HistoryResponse,
  Portfolio,
  PricesResponse,
  RiskRequest,
  RiskResult,
  SimulateRequest,
  SimulationResult,
} from './api-types';
import type { Chain } from './chains';
import type { PendingSignRequest } from './messaging';
import {
  mockChatStream,
  mockExplainForRequest,
  mockFeeAnalytics,
  mockHistory,
  mockPortfolio,
  mockRiskForRequest,
} from './mock-data';
import { extractDelta, parseSseStream } from './sse';

export const API_BASE_URL = 'http://localhost:8080/v1';

const REQUEST_TIMEOUT_MS = 3_000;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `API ${path} → HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** Виконує запит; якщо бекенд недоступний — повертає мок (з попередженням у консолі). */
async function withMockFallback<T>(real: () => Promise<T>, mock: () => T): Promise<T> {
  try {
    return await real();
  } catch (error) {
    console.warn('[aiwallet] Бекенд недоступний, використовую мок-дані:', error);
    return mock();
  }
}

// ---------------------------------------------------------------------------
// Ендпоінти (ТЗ §5)
// ---------------------------------------------------------------------------

/** POST /v1/balances — агрегований портфель по всіх мережах (F2.1). */
export function fetchPortfolio(req: BalancesRequest): Promise<Portfolio> {
  return withMockFallback(() => post<Portfolio>('/balances', req), mockPortfolio);
}

/** GET /v1/history — історія транзакцій з людськими описами (F3.6). */
export function fetchHistory(
  address: string,
  chain?: Chain,
  cursor?: string,
): Promise<HistoryResponse> {
  const params = new URLSearchParams({ address });
  if (chain) params.set('chain', chain);
  if (cursor) params.set('cursor', cursor);
  return withMockFallback(
    () => request<HistoryResponse>(`/history?${params.toString()}`),
    mockHistory,
  );
}

/** POST /v1/tx/decode — структурований розбір транзакції (F4.2). */
export function decodeTx(req: DecodeRequest): Promise<DecodedTx> {
  return post<DecodedTx>('/tx/decode', req);
}

/** POST /v1/tx/simulate — очікувані зміни балансів (F4.3). */
export function simulateTx(req: SimulateRequest): Promise<SimulationResult> {
  return post<SimulationResult>('/tx/simulate', req);
}

/** POST /v1/tx/risk — рівень ризику з причинами (F5.1). */
export function fetchTxRisk(req: RiskRequest): Promise<RiskResult> {
  return post<RiskResult>('/tx/risk', req);
}

/** POST /v1/tx/explain — людське пояснення (F4.1). */
export function explainTx(req: ExplainRequest): Promise<ExplainResponse> {
  return post<ExplainResponse>('/tx/explain', req);
}

/** POST /v1/tx/broadcast — трансляція підписаної транзакції. */
export function broadcastTx(req: BroadcastRequest): Promise<BroadcastResponse> {
  return withMockFallback(
    () => post<BroadcastResponse>('/tx/broadcast', req),
    () => ({ txHash: `0xmock${Math.random().toString(16).slice(2, 10)}…` }),
  );
}

/** GET /v1/analytics/fees — витрати на комісії (F6.1). */
export function fetchFeeAnalytics(
  address: string,
  period: AnalyticsPeriod,
): Promise<FeeAnalytics> {
  const params = new URLSearchParams({ address, period });
  return withMockFallback(
    () => request<FeeAnalytics>(`/analytics/fees?${params.toString()}`),
    mockFeeAnalytics,
  );
}

/** GET /v1/analytics/summary — дані для дашборда. */
export function fetchAnalyticsSummary(
  address: string,
  period: AnalyticsPeriod,
): Promise<AnalyticsSummary> {
  const params = new URLSearchParams({ address, period });
  return request<AnalyticsSummary>(`/analytics/summary?${params.toString()}`);
}

/** GET /v1/prices — ціни (кешуються на бекенді, F2.5). */
export function fetchPrices(ids: readonly string[]): Promise<PricesResponse> {
  return request<PricesResponse>(`/prices?ids=${ids.join(',')}`);
}

// ---------------------------------------------------------------------------
// AI-чат: POST /v1/chat зі стрімінгом через SSE (F7.1–F7.3)
// ---------------------------------------------------------------------------

/**
 * Стрімить відповідь AI по словах/токенах. fetch + ReadableStream + SSE-парсер;
 * якщо бекенд недоступний — локальний мок-стрім (fail-safe).
 */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  let body: ReadableStream<Uint8Array>;
  try {
    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal: signal ?? null,
    });
    if (!response.ok || response.body === null) {
      throw new ApiError(response.status, 'Чат недоступний');
    }
    body = response.body;
  } catch (error) {
    console.warn('[aiwallet] /v1/chat недоступний, мок-стрім:', error);
    yield* mockChatStream(req);
    return;
  }

  for await (const data of parseSseStream(body)) {
    yield extractDelta(data);
  }
}

// ---------------------------------------------------------------------------
// Хелпери для екрана Approve: ризик + пояснення для запиту з черги background.
// Для eth_sendTransaction намагаємось піти в реальні /tx/risk та /tx/explain,
// інакше (або при недоступному бекенді) — локальні моки.
// ---------------------------------------------------------------------------

function toTxRequestDto(request: PendingSignRequest): RiskRequest | null {
  if (request.method !== 'eth_sendTransaction') return null;
  const tx = request.params[0];
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) return null;
  const field = (key: string): string | null => {
    const value = (tx as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    chain: 'ethereum',
    dappOrigin: request.origin,
    txRequest: {
      from: field('from') ?? '',
      to: field('to'),
      value: field('value'),
      data: field('data'),
      gas: field('gas'),
    },
  };
}

export function assessPendingRequest(request: PendingSignRequest): Promise<RiskResult> {
  const riskReq = toTxRequestDto(request);
  if (riskReq === null) {
    return Promise.resolve(mockRiskForRequest(request));
  }
  return withMockFallback(
    () => fetchTxRisk(riskReq),
    () => mockRiskForRequest(request),
  );
}

export function explainPendingRequest(
  request: PendingSignRequest,
  risk: RiskResult | null,
): Promise<string> {
  const riskReq = toTxRequestDto(request);
  if (riskReq === null) {
    return Promise.resolve(mockExplainForRequest(request));
  }
  return withMockFallback(
    async () => {
      const { explanation } = await explainTx({
        decoded: null,
        simulation: null,
        risk,
        lang: 'uk',
      });
      return explanation;
    },
    () => mockExplainForRequest(request),
  );
}
