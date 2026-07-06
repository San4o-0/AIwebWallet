/**
 * Мок-дані для розробки UI, поки бекенд (crates/api-server) не піднято.
 * Використовуються як fallback у src/lib/api.ts.
 */
import type { Chain } from './chains';
import type { Eip1193Method, Json, PendingSignRequest } from './messaging';
import type {
  ChatRequest,
  FeeAnalytics,
  HistoryEntry,
  HistoryResponse,
  Portfolio,
  RiskResult,
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
      description: 'Надіслано 120 USDC на адресу 0x7bC4…9aF1',
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
      description: 'Обмін 1.2 SOL → 178 JUP через Jupiter',
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
      description: 'Дозвіл Uniswap витрачати ваші USDC (обмежений до 500 USDC)',
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
      description: 'Отримано 0.005 BTC від bc1q…f3t4',
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
      description: 'Взаємодія з контрактом Aerodrome: додано ліквідність',
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
      description: 'Mint NFT «Base Camp Badge» (безкоштовно, газ 0.02 POL)',
      amountUsd: -0.01,
      direction: 'out',
      status: 'failed',
    },
  ];
  return { items, nextCursor: null };
}

export function mockFeeAnalytics(): FeeAnalytics {
  return {
    period: '30d',
    totalUsd: 14.62,
    byChain: [
      { chain: 'ethereum', usd: 11.2 },
      { chain: 'solana', usd: 0.42 },
      { chain: 'bitcoin', usd: 2.1 },
      { chain: 'polygon', usd: 0.9 },
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
      reasons: ['Запит лише на підключення: dApp побачить вашу публічну адресу.'],
    };
  }
  if (request.method === 'personal_sign') {
    return {
      level: 'medium',
      reasons: [
        'Підпис довільного повідомлення: перевірте, що текст зрозумілий.',
        'Домен dApp не знайдено в списках довірених.',
      ],
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
        'Unlimited approve: dApp зможе витратити ВСІ ваші токени цього типу.',
        'Контракт створено менш ніж 7 днів тому і не верифіковано.',
        'Домен dApp схожий на відомий фішинговий шаблон.',
      ],
    };
  }
  if (typeof data === 'string' && data.length > 2) {
    return {
      level: 'medium',
      reasons: [
        'Виклик контракту, який не вдалося повністю декодувати.',
        'Симуляція показує зменшення балансу на невідому суму.',
      ],
    };
  }
  return {
    level: 'low',
    reasons: ['Простий переказ нативної монети на адресу без ознак ризику.'],
  };
}

/** Мок людського пояснення транзакції (реальне — POST /v1/tx/explain). */
export function mockExplainForRequest(request: PendingSignRequest): string {
  switch (request.method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return `Сайт ${request.origin} просить підключитися до вашого гаманця. Він побачить адресу та баланс, але не зможе нічого витратити без окремого підпису.`;
    case 'personal_sign':
      return `Сайт ${request.origin} просить підписати повідомлення. Підпис не витрачає кошти, але може використовуватись для входу або авторизації дій від вашого імені.`;
    case 'eth_sendTransaction': {
      const risk = mockRiskForRequest(request);
      if (risk.level === 'high') {
        return `Ви даєте ${request.origin} дозвіл витрачати ВСІ ваші USDC без обмежень. Якщо контракт зловмисний — кошти буде втрачено.`;
      }
      if (risk.level === 'medium') {
        return `Ви викликаєте функцію контракту через ${request.origin}. За симуляцією ваш баланс зменшиться; точну суму декодувати не вдалося.`;
      }
      return `Ви надсилаєте 0.01 ETH (≈ $32.50) на адресу 0x7bC4…9aF1. Комісія ≈ $1.20.`;
    }
    case 'eth_chainId':
      return 'Службовий запит ідентифікатора мережі.';
  }
}

const MOCK_CHAT_ANSWER =
  'За останні 30 днів ви витратили приблизно $14.62 на комісії: ' +
  '$11.20 в Ethereum, $2.10 у Bitcoin, $0.90 у Polygon і $0.42 у Solana. ' +
  'Найдорожчою була транзакція approve для Uniswap ($4.80). ' +
  'Порада: в Ethereum комісії вночі за UTC зазвичай на 30–50% нижчі. ' +
  '\n\n_(Це мок-відповідь: бекенд /v1/chat недоступний.)_';

/** Мок стрімінгової відповіді чату — імітує SSE зі /v1/chat. */
export async function* mockChatStream(_request: ChatRequest): AsyncGenerator<string, void, void> {
  const words = MOCK_CHAT_ANSWER.split(' ');
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
