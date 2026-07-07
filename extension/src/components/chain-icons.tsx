/**
 * Логотипи мереж: інлайнові SVG без бібліотек і CDN (як icons.tsx).
 * Стиль — круглий бейдж у брендовому кольорі мережі з білим гліфом
 * (спрощені фірмові знаки, впізнавані на 18–22px у списках).
 */
import type { SVGProps } from 'react';

import type { Chain } from '@/src/lib/chains';

export interface ChainIconProps extends SVGProps<SVGSVGElement> {
  chain: Chain;
  size?: number;
}

function badge(size: number | undefined, props: Omit<SVGProps<SVGSVGElement>, 'children'>) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    ...props,
  } as const;
}

function EthereumIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#627eea" />
      <path d="M12 4 7.4 12.4 12 15.1l4.6-2.7L12 4Z" fill="#fff" fillOpacity=".92" />
      <path d="M7.4 13.9 12 16.6l4.6-2.7L12 20 7.4 13.9Z" fill="#fff" fillOpacity=".7" />
    </svg>
  );
}

function PolygonIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#8247e5" />
      <path
        d="M15.9 9.9a.9.9 0 0 0-.86 0l-2 1.16-1.36.77-1.96 1.15a.9.9 0 0 1-.86 0l-1.53-.9a.87.87 0 0 1-.43-.75V9.58c0-.3.16-.6.43-.75l1.52-.88a.9.9 0 0 1 .86 0l1.52.9c.27.15.43.44.43.74v1.16l1.36-.79V8.79c0-.3-.16-.6-.43-.75L9.87 6.4a.9.9 0 0 0-.86 0L6.13 8.06a.86.86 0 0 0-.43.74v3.32c0 .3.16.6.43.75l2.87 1.65a.9.9 0 0 0 .86 0l1.96-1.13 1.36-.8 1.96-1.13a.9.9 0 0 1 .86 0l1.52.88c.27.15.43.44.43.75v1.78c0 .3-.16.6-.43.75l-1.51.9a.9.9 0 0 1-.86 0l-1.52-.88a.88.88 0 0 1-.43-.75v-1.14l-1.36.79v1.16c0 .3.16.6.43.75l2.87 1.65a.9.9 0 0 0 .86 0l2.87-1.65c.26-.16.43-.45.43-.75v-3.34c0-.3-.16-.6-.43-.75L15.9 9.9Z"
        fill="#fff"
      />
    </svg>
  );
}

function BscIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#f0b90b" />
      <path
        d="M12 4.6 14.5 7.1 12 9.6 9.5 7.1 12 4.6ZM7.1 9.5 9.6 12l-2.5 2.5L4.6 12l2.5-2.5Zm9.8 0 2.5 2.5-2.5 2.5-2.5-2.5 2.5-2.5ZM12 9.9l2.1 2.1-2.1 2.1L9.9 12 12 9.9Zm0 4.5 2.5 2.5L12 19.4l-2.5-2.5 2.5-2.5Z"
        fill="#fff"
      />
    </svg>
  );
}

function ArbitrumIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#213147" />
      {/* Спрощений знак: два висхідні «піки» фірмового блакитного */}
      <path d="m12.3 5.6 4.9 12.6h-2.6l-3.6-9.3 1.3-3.3Z" fill="#28a0f0" />
      <path d="m10.9 9.3 3.4 8.9h-2.6l-2.1-5.5 1.3-3.4Z" fill="#28a0f0" fillOpacity=".75" />
      <path d="M12.3 5.6 6.8 18.2h2.5l4.3-9.9-1.3-2.7Z" fill="#fff" fillOpacity=".9" />
    </svg>
  );
}

function BaseIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#0052ff" />
      <path d="M1.1 10.9h12.3v2.2H1.1a11 11 0 0 1 0-2.2Z" fill="#fff" />
    </svg>
  );
}

function SolanaIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#9945ff" />
      <path d="M8.3 6.9h9.5l-2.1 2.1H6.2l2.1-2.1Z" fill="#fff" />
      <path d="M6.2 11h9.5l2.1 2.1H8.3L6.2 11Z" fill="#fff" fillOpacity=".85" />
      <path d="M8.3 15.1h9.5l-2.1 2.1H6.2l2.1-2.1Z" fill="#fff" />
    </svg>
  );
}

function BitcoinIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#f7931a" />
      <g
        transform="rotate(12 12 12)"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M9.4 7.4v9.2" />
        <path d="M9.4 7.4h3.7a2.2 2.2 0 0 1 0 4.4H9.4" />
        <path d="M9.4 11.8h4.3a2.4 2.4 0 0 1 0 4.8H9.4" />
        <path d="M10.7 5.8v1.6M12.8 5.8v1.6M10.7 16.6v1.6M12.8 16.6v1.6" />
      </g>
    </svg>
  );
}

function TronIcon(props: ReturnType<typeof badge>) {
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="12" fill="#eb0029" />
      {/* Спрощений знак TRON: чотиригранний «щит» із вершиною внизу */}
      <path
        d="M5.5 5.5 18.9 8.2 12.4 19.6 5.5 5.5Zm2.6 2.3 4.3 8.8 1-6.9-5.3-1.9Zm6.8 2.2-.9 6.2 3.5-6.1-2.6-.1Zm1.6-1.5 1.9.1-3.2-1.1 1.3 1Z"
        fill="#fff"
      />
    </svg>
  );
}

const ICONS: Record<Chain, (props: ReturnType<typeof badge>) => JSX.Element> = {
  ethereum: EthereumIcon,
  polygon: PolygonIcon,
  bsc: BscIcon,
  arbitrum: ArbitrumIcon,
  base: BaseIcon,
  solana: SolanaIcon,
  bitcoin: BitcoinIcon,
  tron: TronIcon,
};

/** Логотип мережі за її ChainId (розмір за замовчуванням 20px). */
export function ChainIcon({ chain, size, ...props }: ChainIconProps) {
  const Icon = ICONS[chain];
  return <Icon {...badge(size, props)} />;
}
