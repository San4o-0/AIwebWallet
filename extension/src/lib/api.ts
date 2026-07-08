/**
 * Типізований клієнт API бекенду (ТЗ §5): http://localhost:8080/v1.
 *
 * Поки бекенд (crates/api-server) у розробці, кожен метод має fallback на
 * мок-дані — гаманець залишається робочим без бекенду (fail-safe, ТЗ §1.2).
 */
import type {
  AnalyticsPeriod,
  BalancesRequest,
  BroadcastRequest,
  BroadcastResponse,
  ChatRequest,
  DecodeRequest,
  DecodedTx,
  ExplainRequest,
  ExplainResponse,
  FeesResponse,
  HistoryResponse,
  Portfolio,
  PricesResponse,
  RiskRequest,
  RiskResult,
  SimulateRequest,
  SimulationResult,
  SummaryResponse,
  TxParams,
} from './api-types';
import type { TokenBalance } from './api-types';
import type { Chain } from './chains';
import { sharedLocale } from './i18n-bridge';
import type { PendingSignRequest } from './messaging';
import {
  mockAnalyticsSummary,
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
    // Бекенд повертає {"error": "..."} — дістаємо людський текст, якщо є.
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) detail = body.error;
    } catch {
      /* тіло не JSON — залишаємо HTTP-статус */
    }
    throw new ApiError(response.status, detail);
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
    console.warn('[aiwallet] Backend unavailable, using mock data:', error);
    return mock();
  }
}

/**
 * Критичні операції (підпис/broadcast) без мок-fallback. Помилки кидаються
 * i18n-КЛЮЧАМИ (`errors.api.*|{параметри}`): модуль бандлиться і в
 * background, тож перекладає їх попап через localizeError.
 */
async function withBackendRequired<T>(
  real: () => Promise<T>,
  action: 'txParams' | 'broadcast',
): Promise<T> {
  try {
    return await real();
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`errors.api.${action}Failed|${JSON.stringify({ detail: error.message })}`);
    }
    throw new Error(`errors.api.${action}Unavailable|${JSON.stringify({ url: API_BASE_URL })}`);
  }
}

// ---------------------------------------------------------------------------
// Нормалізація wire-форматів бекенду (crates/api-server серіалізує DTO у
// snake_case, а суми — у базових одиницях). БЕЗ нормалізації розбіжність
// форм (`portfolio.tokens === undefined`) валила React-дерево попапа —
// у Firefox це проявлялось як повністю чорний екран після онбордингу.
// ---------------------------------------------------------------------------

/** Токен у wire-форматі /v1/balances: суми в базових одиницях (wei/lamports). */
interface WireTokenBalance {
  symbol: string;
  name: string;
  contract_address: string | null;
  amount: string;
  decimals: number;
  usd_value: number;
}

interface WireChainBalances {
  chain: Chain;
  address: string;
  native: WireTokenBalance;
  tokens: WireTokenBalance[];
  usd_value: number;
}

interface WirePortfolio {
  total_usd: number;
  chains: WireChainBalances[];
  /** Unix seconds останнього оновлення цін. */
  prices_updated_at: number;
}

/** «14142755499043161546915» (18 dec) → «14142.755499» — без втрати точності BigInt. */
function formatBaseUnits(raw: string, decimals: number): string {
  try {
    const value = BigInt(raw);
    const sign = value < 0n ? '-' : '';
    const abs = value < 0n ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const fraction = (abs % base)
      .toString()
      .padStart(decimals, '0')
      .slice(0, 6)
      .replace(/0+$/, '');
    return fraction.length > 0 ? `${sign}${whole.toString()}.${fraction}` : `${sign}${whole.toString()}`;
  } catch {
    return raw; // не BigInt-рядок — показуємо як є
  }
}

function toTokenBalance(chain: Chain, token: WireTokenBalance, isNative: boolean): TokenBalance {
  const amount = formatBaseUnits(token.amount, token.decimals);
  const amountNumber = Number(amount);
  return {
    chain,
    symbol: token.symbol,
    name: token.name,
    amount,
    decimals: token.decimals,
    usdPrice: Number.isFinite(amountNumber) && amountNumber > 0 ? token.usd_value / amountNumber : 0,
    usdValue: token.usd_value,
    isNative,
    contractAddress: token.contract_address,
  };
}

/**
 * Приводить відповідь /v1/balances до UI-форми Portfolio. Приймає і цільову
 * форму (якщо бекенд колись перейде на camelCase), і поточний wire-формат;
 * невідома форма → помилка → withMockFallback підставить мок (fail-safe).
 */
function normalizePortfolio(raw: unknown): Portfolio {
  const value = raw as Partial<Portfolio> & Partial<WirePortfolio>;
  if (Array.isArray(value.tokens) && typeof value.totalUsd === 'number') {
    return value as Portfolio;
  }
  if (Array.isArray(value.chains)) {
    const tokens: TokenBalance[] = [];
    for (const chainBalances of value.chains) {
      tokens.push(toTokenBalance(chainBalances.chain, chainBalances.native, true));
      for (const token of chainBalances.tokens) {
        tokens.push(toTokenBalance(chainBalances.chain, token, false));
      }
    }
    const updatedAtSec = typeof value.prices_updated_at === 'number' ? value.prices_updated_at : 0;
    return {
      totalUsd:
        typeof value.total_usd === 'number'
          ? value.total_usd
          : tokens.reduce((sum, t) => sum + t.usdValue, 0),
      tokens,
      updatedAt: new Date(updatedAtSec > 0 ? updatedAtSec * 1000 : Date.now()).toISOString(),
    };
  }
  throw new Error('Unknown /v1/balances response shape');
}

/** Приводить /v1/history до HistoryResponse (бекенд шле next_cursor). */
function normalizeHistory(raw: unknown): HistoryResponse {
  const value = raw as Partial<HistoryResponse> & { next_cursor?: string | null };
  return {
    items: Array.isArray(value.items) ? value.items : [],
    nextCursor: value.nextCursor ?? value.next_cursor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ендпоінти (ТЗ §5)
// ---------------------------------------------------------------------------

/** POST /v1/balances — агрегований портфель по всіх мережах (F2.1). */
export function fetchPortfolio(req: BalancesRequest): Promise<Portfolio> {
  return withMockFallback(
    async () => normalizePortfolio(await post<unknown>('/balances', req)),
    mockPortfolio,
  );
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
    async () => normalizeHistory(await request<unknown>(`/history?${params.toString()}`)),
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

/**
 * GET /v1/tx/params — nonce, gas limit та EIP-1559 комісії для збірки
 * транзакції. БЕЗ мок-fallback: без реальних параметрів підписувати не можна.
 */
export function fetchTxParams(
  chain: Chain,
  from: string,
  isToken = false,
): Promise<TxParams> {
  const params = new URLSearchParams({ chain, from });
  if (isToken) params.set('token', '1');
  return withBackendRequired(
    () => request<TxParams>(`/tx/params?${params.toString()}`),
    'txParams',
  );
}

/**
 * POST /v1/tx/broadcast — трансляція підписаної транзакції.
 * БЕЗ мок-fallback: якщо бекенд недоступний — зрозуміла помилка,
 * жодних фейкових tx-хешів.
 */
export function broadcastTx(req: BroadcastRequest): Promise<BroadcastResponse> {
  return withBackendRequired(
    () => post<BroadcastResponse>('/tx/broadcast', req),
    'broadcast',
  );
}

/** GET /v1/analytics/fees — витрати на комісії за період (F6.1). */
export function fetchFeeAnalytics(
  address: string,
  period: AnalyticsPeriod,
): Promise<FeesResponse> {
  const params = new URLSearchParams({ address, period });
  return withMockFallback(
    () => request<FeesResponse>(`/analytics/fees?${params.toString()}`),
    () => mockFeeAnalytics(period),
  );
}

/** GET /v1/analytics/summary — зведення транзакцій для екрана «Аналітика». */
export function fetchAnalyticsSummary(
  address: string,
  period: AnalyticsPeriod,
): Promise<SummaryResponse> {
  const params = new URLSearchParams({ address, period });
  return withMockFallback(
    () => request<SummaryResponse>(`/analytics/summary?${params.toString()}`),
    () => mockAnalyticsSummary(period),
  );
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
  // Активна локаль UI → поле lang (бекенд поки ігнорує його — TODO на боці
  // crates/api-server: враховувати lang у промпті чату).
  const payload: ChatRequest = { lang: sharedLocale(), ...req };
  try {
    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: signal ?? null,
    });
    if (!response.ok || response.body === null) {
      throw new ApiError(response.status, 'Chat endpoint unavailable');
    }
    body = response.body;
  } catch (error) {
    console.warn('[aiwallet] /v1/chat unavailable, using mock stream:', error);
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
        // Активна локаль UI — бекенд приймає довільний рядок lang.
        lang: sharedLocale(),
      });
      return explanation;
    },
    () => mockExplainForRequest(request),
  );
}
