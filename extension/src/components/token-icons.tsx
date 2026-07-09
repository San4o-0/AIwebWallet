/**
 * Логотипи токенів: інлайнові SVG у стилі chain-icons.tsx — кругла плашка
 * (монета) у фірмовому кольорі стейблкоїна з білим гліфом. Для невідомих
 * символів — fallback: перша літера у кружку в детермінованому кольорі.
 */
import type { SVGProps } from 'react';

export interface TokenIconProps extends SVGProps<SVGSVGElement> {
  symbol: string;
  size?: number;
}

function coin(size: number | undefined, props: Omit<SVGProps<SVGSVGElement>, 'children'>) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    ...props,
  } as const;
}

/** Кругла монета-фон + білий гліф (літера з mono-шрифту, ASCII-safe). */
function Coin({ bg, glyph }: { bg: string; glyph: string }) {
  return (
    <>
      <circle cx="12" cy="12" r="11" fill={bg} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-mono)"
        fontSize="12"
        fontWeight="700"
        fill="#fff"
      >
        {glyph}
      </text>
    </>
  );
}

/** Фірмові кольори + гліф відомих стейблкоїнів (ASCII, у latin-сабсеті). */
const KNOWN: Record<string, { bg: string; glyph: string }> = {
  USDC: { bg: '#2775ca', glyph: '$' }, // синій долар
  USDT: { bg: '#26a17b', glyph: 'T' }, // teal Tether
  DAI: { bg: '#f5ac37', glyph: 'D' }, // золотий DAI
};

/** Детермінований відтінок для fallback-монети (стабільний за символом). */
function fallbackColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) % 360;
  return `hsl(${hash} 42% 46%)`;
}

/** Логотип токена за символом; для невідомих — перша літера у кружку. */
export function TokenIcon({ symbol, size, ...props }: TokenIconProps) {
  const known = KNOWN[symbol.toUpperCase()];
  const { bg, glyph } = known ?? {
    bg: fallbackColor(symbol),
    glyph: (symbol[0] ?? '?').toUpperCase(),
  };
  return (
    <svg {...coin(size, props)}>
      <Coin bg={bg} glyph={glyph} />
    </svg>
  );
}
