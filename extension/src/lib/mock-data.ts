/**
 * Мок-дані для розробки UI, поки бекенд (crates/api-server) не піднято.
 * Використовуються як fallback у src/lib/api.ts.
 */
import type { Chain } from './chains';
import { sharedT as t } from './i18n-bridge';
import type { Eip1193Method, Json, PendingSignRequest } from './messaging';
import type {
  AnalyticsPeriod,
  ChatRequest,
  FeePoint,
  FeesResponse,
  HistoryEntry,
  HistoryResponse,
  Portfolio,
  RiskResult,
  SummaryResponse,
  TokenBalance,
} from './api-types';

const token = (
  chain: Chain,
  symbol: string,
  name: string,
  amount: string,
  usdPrice: number,
  isNative: boolean,
  contractAddress: string | null = null,
): TokenBalance => ({
  chain,
  symbol,
  name,
  amount,
  decimals: 18,
  usdPrice,
  usdValue: Number.parseFloat(amount) * usdPrice,
  isNative,
  contractAddress,
});

export function mockPortfolio(): Portfolio {
  const tokens: TokenBalance[] = [
    token('ethereum', 'ETH', 'Ether', '0.8421', 3250.4, true),
    token('ethereum', 'USDC', 'USD Coin', '412.50', 1.0, false, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    token('polygon', 'POL', 'Polygon', '310.2', 0.42, true),
    token('bsc', 'BNB', 'BNB', '0.55', 590.1, true),
    token('arbitrum', 'ETH', 'Ether (Arbitrum)', '0.12', 3250.4, true),
    token('arbitrum', 'ARB', 'Arbitrum', '95.0', 0.71, false, '0x912CE59144191C1204E64559FE8253a0e49E6548'),
    token('base', 'ETH', 'Ether (Base)', '0.05', 3250.4, true),
    token('solana', 'SOL', 'Solana', '4.31', 148.9, true),
    token('solana', 'JUP', 'Jupiter', '120.0', 0.62, false, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
    token('bitcoin', 'BTC', 'Bitcoin', '0.0125', 67350.0, true),
  ];
  return {
    totalUsd: tokens.reduce((sum, t) => sum + t.usdValue, 0),
    tokens,
    updatedAt: new Date().toISOString(),
  };
}

export function mockHistory(): HistoryResponse {
  const now = Date.now();
  const items: HistoryEntry[] = [
    {
      id: 'tx-1',
      chain: 'ethereum',
      hash: '0x8f3a…c21b',
      timestamp: now - 35 * 60_000,
      category: 'transfer',
      description: t('mock.history.tx1'),
      amountUsd: -120.0,
      direction: 'out',
      status: 'confirmed',
    },
    {
      id: 'tx-2',
      chain: 'solana',
      hash: '5KtP…w9Qx',
      timestamp: now - 3 * 3_600_000,
      category: 'swap',
      description: t('mock.history.tx2'),
      amountUsd: -178.7,
      direction: 'self',
      status: 'confirmed',
    },
    {
      id: 'tx-3',
      chain: 'ethereum',
      hash: '0x11de…08aa',
      timestamp: now - 26 * 3_600_000,
      category: 'approve',
      description: t('mock.history.tx3'),
      amountUsd: null,
      direction: 'self',
      status: 'confirmed',
    },
    {
      id: 'tx-4',
      chain: 'bitcoin',
      hash: 'a91c…77e0',
      timestamp: now - 2 * 86_400_000,
      category: 'transfer',
      description: t('mock.history.tx4'),
      amountUsd: 336.75,
      direction: 'in',
      status: 'confirmed',
    },
    {
      id: 'tx-5',
      chain: 'base',
      hash: '0x40b1…d3ce',
      timestamp: now - 4 * 86_400_000,
      category: 'dapp',
      description: t('mock.history.tx5'),
      amountUsd: -52.3,
      direction: 'out',
      status: 'confirmed',
    },
    {
      id: 'tx-6',
      chain: 'polygon',
      hash: '0x77aa…1f02',
      timestamp: now - 6 * 86_400_000,
      category: 'mint',
      description: t('mock.history.tx6'),
      amountUsd: -0.01,
      direction: 'out',
      status: 'failed',
    },
  ];
  return { items, nextCursor: null };
}

/** Кількість днів у періоді аналітики. */
const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

/**
 * Детермінований псевдовипадковий таймлайн комісій (без Math.random —
 * стабільний між рендерами; сума масштабується під тотал).
 */
function mockTimeline(period: AnalyticsPeriod, totalUsd: number): FeePoint[] {
  const days = Math.min(PERIOD_DAYS[period], 90); // бекенд агрегує по днях
  const dayMs = 86_400_000;
  const start = Math.floor(Date.now() / dayMs) * dayMs - (days - 1) * dayMs;
  const raw = Array.from({ length: days }, (_, i) => {
    const wave = Math.sin(i * 1.7) + Math.sin(i * 0.43 + 2);
    return Math.max(0, wave + 1.2) * (i % 5 === 3 ? 2.4 : 1);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((value, i) => ({
    date: Math.floor((start + i * dayMs) / 1000),
    fees_usd: sum > 0 ? (value / sum) * totalUsd : 0,
  }));
}

export function mockFeeAnalytics(period: AnalyticsPeriod = '30d'): FeesResponse {
  const scale = PERIOD_DAYS[period] / 30;
  const totalUsd = 14.62 * scale;
  return {
    address: '0x0000000000000000000000000000000000000000',
    period,
    total_fees_usd: totalUsd,
    by_chain: [
      { chain: 'ethereum', fees_usd: 11.2 * scale, tx_count: Math.round(9 * scale) },
      { chain: 'bitcoin', fees_usd: 2.1 * scale, tx_count: Math.round(2 * scale) },
      { chain: 'polygon', fees_usd: 0.9 * scale, tx_count: Math.round(6 * scale) },
      { chain: 'solana', fees_usd: 0.42 * scale, tx_count: Math.round(11 * scale) },
    ],
    timeline: mockTimeline(period, totalUsd),
  };
}

export function mockAnalyticsSummary(period: AnalyticsPeriod = '30d'): SummaryResponse {
  const scale = PERIOD_DAYS[period] / 30;
  return {
    address: '0x0000000000000000000000000000000000000000',
    period,
    total_in_usd: 1240.5 * scale,
    total_out_usd: 863.2 * scale,
    total_fees_usd: 14.62 * scale,
    tx_count: Math.round(28 * scale),
    by_category: [
      { category: 'transfer', tx_count: Math.round(13 * scale), volume_usd: 980.4 * scale },
      { category: 'swap', tx_count: Math.round(7 * scale), volume_usd: 611.9 * scale },
      { category: 'dapp', tx_count: Math.round(5 * scale), volume_usd: 342.1 * scale },
      { category: 'approve', tx_count: Math.round(2 * scale), volume_usd: 0 },
      { category: 'mint', tx_count: Math.round(1 * scale), volume_usd: 52.3 * scale },
    ],
    by_chain: [
      { chain: 'ethereum', fees_usd: 11.2 * scale, tx_count: Math.round(9 * scale) },
      { chain: 'bitcoin', fees_usd: 2.1 * scale, tx_count: Math.round(2 * scale) },
      { chain: 'polygon', fees_usd: 0.9 * scale, tx_count: Math.round(6 * scale) },
      { chain: 'solana', fees_usd: 0.42 * scale, tx_count: Math.round(11 * scale) },
    ],
  };
}

/**
 * Мок ризик-скорингу для запиту на підпис.
 * Реальний rule-based скоринг — на бекенді (risk-engine, ТЗ F5.1–F5.5).
 */
export function mockRiskForRequest(request: PendingSignRequest): RiskResult {
  if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') {
    return {
      level: 'low',
      reasons: [t('mock.risk.connect')],
    };
  }
  if (request.method === 'personal_sign') {
    return {
      level: 'medium',
      reasons: [t('mock.risk.personalSign1'), t('mock.risk.personalSign2')],
    };
  }
  // eth_sendTransaction
  const tx = request.params[0];
  const data =
    typeof tx === 'object' && tx !== null && !Array.isArray(tx)
      ? (tx as Record<string, Json>)['data']
      : undefined;
  if (typeof data === 'string' && data.startsWith('0x095ea7b3')) {
    return {
      level: 'high',
      reasons: [
        t('mock.risk.approveUnlimited1'),
        t('mock.risk.approveUnlimited2'),
        t('mock.risk.approveUnlimited3'),
      ],
    };
  }
  if (typeof data === 'string' && data.length > 2) {
    return {
      level: 'medium',
      reasons: [t('mock.risk.unknownCall1'), t('mock.risk.unknownCall2')],
    };
  }
  return {
    level: 'low',
    reasons: [t('mock.risk.simpleTransfer')],
  };
}

/** Мок людського пояснення транзакції (реальне — POST /v1/tx/explain). */
export function mockExplainForRequest(request: PendingSignRequest): string {
  switch (request.method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return t('mock.explain.connect', { origin: request.origin });
    case 'personal_sign':
      return t('mock.explain.personalSign', { origin: request.origin });
    case 'eth_sendTransaction': {
      const risk = mockRiskForRequest(request);
      if (risk.level === 'high') {
        return t('mock.explain.approveHigh', { origin: request.origin });
      }
      if (risk.level === 'medium') {
        return t('mock.explain.contractMedium', { origin: request.origin });
      }
      return t('mock.explain.transferLow');
    }
    case 'eth_chainId':
      return t('mock.explain.chainId');
  }
}

/** Мок стрімінгової відповіді чату — імітує SSE зі /v1/chat. */
export async function* mockChatStream(_request: ChatRequest): AsyncGenerator<string, void, void> {
  const words = t('mock.chatAnswer').split(' ');
  for (const word of words) {
    await new Promise((resolve) => setTimeout(resolve, 35));
    yield `${word} `;
  }
}

/** Мок-запит для демонстрації екрана Approve, коли черга порожня (dev-режим). */
export function mockPendingRequest(): PendingSignRequest {
  const method: Eip1193Method = 'eth_sendTransaction';
  return {
    id: 'demo-request',
    origin: 'https://app.uniswap.org',
    method,
    params: [
      {
        from: '0x1F9840a85d5aF5bf1D1762F925BDADdC4201F984',
        to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        value: '0x0',
        data: '0x095ea7b3000000000000000000000000ffffffffffffffffffffffffffffffffffffffff',
      },
    ],
    createdAt: Date.now(),
  };
}
