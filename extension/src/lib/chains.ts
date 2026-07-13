/**
 * Мережі MVP (ТЗ F2.2). color — жива ідентичність мережі: бейджі, капсули
 * тикерів і КАТЕГОРІАЛЬНА палітра графіків (фіксований порядок реєстру,
 * ніколи не циклічно). Відтінки бренд-кольорів підігнано під валідатор
 * dataviz (dark-поверхня #14161A): lightness band 0.48–0.67, chroma ≥ 0.10,
 * CVD ΔE(adjacent) ≥ 13.9, контраст ≥ 3:1 — див. entrypoints/popup/style.css.
 */
export const CHAINS = {
  ethereum: { label: 'Ethereum', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0x1', color: '#7d8dd5' },
  polygon: { label: 'Polygon', symbol: 'POL', kind: 'evm', evmChainIdHex: '0x89', color: '#8247e5' },
  bsc: { label: 'BSC', symbol: 'BNB', kind: 'evm', evmChainIdHex: '0x38', color: '#b88a00' },
  arbitrum: { label: 'Arbitrum', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0xa4b1', color: '#3f99d2' },
  base: { label: 'Base', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0x2105', color: '#2151f5' },
  solana: { label: 'Solana', symbol: 'SOL', kind: 'solana', evmChainIdHex: null, color: '#be51e9' },
  bitcoin: { label: 'Bitcoin', symbol: 'BTC', kind: 'bitcoin', evmChainIdHex: null, color: '#d37900' },
  tron: { label: 'TRON', symbol: 'TRX', kind: 'tron', evmChainIdHex: null, color: '#eb0029' },
} as const;

export type Chain = keyof typeof CHAINS;

export const CHAIN_IDS = Object.keys(CHAINS) as Chain[];

export type ChainKind = (typeof CHAINS)[Chain]['kind'];

/**
 * ЛОКАЛЬНА (не з мережі) числова константа EIP-155 chain id мережі:
 * `evmChainIdHex` реєстру → number. null для не-EVM мереж.
 *
 * Це джерело правди для перевірки `chain_id`, що приходить із бекенду
 * (GET /v1/tx/params) ПЕРЕД підписом: підписаний RLP містить chain_id, тож
 * підміна цього поля (MITM/компрометація бекенду) дала б валідний підпис у
 * ЧУЖІЙ мережі (replay). Див. verifyTxParams() у src/lib/evm.ts.
 */
export function evmChainId(chain: Chain): number | null {
  const hex = CHAINS[chain].evmChainIdHex;
  if (hex === null) return null;
  const value = Number.parseInt(hex, 16);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Базові URL блок-експлорерів для сторінки транзакції (за hash). Виносимо
 * окремо від CHAINS, щоб не роздувати `as const`-реєстр; використовується у
 * детальному перегляді транзакції (кнопка «Переглянути в експлорері»).
 */
const EXPLORER_TX_BASE: Record<Chain, string> = {
  ethereum: 'https://etherscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
  bsc: 'https://bscscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  base: 'https://basescan.org/tx/',
  solana: 'https://solscan.io/tx/',
  bitcoin: 'https://mempool.space/tx/',
  tron: 'https://tronscan.org/#/transaction/',
};

/** Повний URL сторінки транзакції в блок-експлорері мережі. */
export function explorerTxUrl(chain: Chain, hash: string): string {
  return `${EXPLORER_TX_BASE[chain]}${hash}`;
}
