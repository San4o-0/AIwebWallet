/** Мережі MVP (ТЗ F2.2). */
export const CHAINS = {
  ethereum: { label: 'Ethereum', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0x1', color: '#627eea' },
  polygon: { label: 'Polygon', symbol: 'POL', kind: 'evm', evmChainIdHex: '0x89', color: '#8247e5' },
  bsc: { label: 'BSC', symbol: 'BNB', kind: 'evm', evmChainIdHex: '0x38', color: '#f0b90b' },
  arbitrum: { label: 'Arbitrum', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0xa4b1', color: '#2d374b' },
  base: { label: 'Base', symbol: 'ETH', kind: 'evm', evmChainIdHex: '0x2105', color: '#0052ff' },
  solana: { label: 'Solana', symbol: 'SOL', kind: 'solana', evmChainIdHex: null, color: '#9945ff' },
  bitcoin: { label: 'Bitcoin', symbol: 'BTC', kind: 'bitcoin', evmChainIdHex: null, color: '#f7931a' },
} as const;

export type Chain = keyof typeof CHAINS;

export const CHAIN_IDS = Object.keys(CHAINS) as Chain[];

export type ChainKind = (typeof CHAINS)[Chain]['kind'];
