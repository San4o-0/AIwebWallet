/**
 * Аналітика (F6.1) — вкладка екрана «Активність»: комісії та зведення
 * транзакцій за період з GET /v1/analytics/fees + /v1/analytics/summary.
 *
 * Форма за методикою dataviz:
 *   1) фільтр періоду — ОДИН ряд сегментів над усім, що він скоупить;
 *   2) stat-плитки (комісії hero-числом, кількість транзакцій) — не графіки;
 *   3) комісії за часом — стовпчиковий таймлайн (тонкі бари, 4px закруглення
 *      лише зверху, gap 2px, одна вісь, ледь помітна сітка, hover-тултип);
 *   4) розподіл по мережах — горизонтальні бари у ВАЛІДОВАНИХ кольорах мереж
 *      (фіксований порядок реєстру, пряме підписування ≤4 найбільших);
 *   5) по категоріях — sequential-бурштин (один hue, magnitude, не identity).
 *
 * Чистий SVG/HTML без chart-бібліотек. Числа — mono + tabular-nums,
 * текст — лише текстові токени (ніколи не колір серії).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BackendWakingNote } from '@/src/components/backend-status';
import { NetworkOffNote, useNetworkAllowed } from '@/src/components/consent';
import { Card, EmptyState, ErrorNote, Eyebrow } from '@/src/components/ui';
import { fetchAnalyticsSummary, fetchFeeAnalytics } from '@/src/lib/api';
import type { AnalyticsPeriod, FeePoint, TxCategory } from '@/src/lib/api-types';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { formatUsd } from '@/src/lib/format';
import { getActiveLocale } from '@/src/i18n';
import { useWalletStore } from '@/src/store/wallet';

/** Періоди фільтра — порядок і ключі підписів. */
const PERIODS: { id: AnalyticsPeriod; labelKey: string }[] = [
  { id: '7d', labelKey: 'analytics.period7d' },
  { id: '30d', labelKey: 'analytics.period30d' },
  { id: '90d', labelKey: 'analytics.period90d' },
  { id: '1y', labelKey: 'analytics.period1y' },
];

/** i18n-ключі категорій (ті самі, що в історії). */
const CATEGORY_LABEL_KEY: Record<TxCategory, string> = {
  transfer: 'category.transfer',
  swap: 'category.swap',
  approve: 'category.approve',
  mint: 'category.mint',
  dapp: 'category.dapp',
};

/**
 * Sequential-бурштин для категорій (magnitude, НЕ identity): один hue
 * (OKLCH H≈72), монотонна світлість 0.80→0.52, найбільша категорія —
 * найсвітліший крок (dark-mode анкор), усі кроки ≥3.2:1 до #14161A.
 */
const AMBER_RAMP = ['#ecb166', '#d89a44', '#c38323', '#a97015', '#8e5d11'];

export default function Analytics() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const networkAllowed = useNetworkAllowed();
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');
  const address = account?.addresses.evm ?? '';

  // Під час зміни періоду тримаємо попередній рендер (без skeleton-спалаху).
  const fees = useQuery({
    queryKey: ['analytics-fees', address, period],
    queryFn: () => fetchFeeAnalytics(address, period),
    enabled: account !== null && networkAllowed,
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    queryKey: ['analytics-summary', address, period],
    queryFn: () => fetchAnalyticsSummary(address, period),
    enabled: account !== null && networkAllowed,
    placeholderData: keepPreviousData,
  });

  const isLoading = fees.isLoading || summary.isLoading;
  const isError = fees.isError || summary.isError;
  const refreshing = fees.isPlaceholderData || summary.isPlaceholderData;

  const hasAnyData =
    (fees.data !== undefined && fees.data.total_fees_usd > 0) ||
    (summary.data !== undefined && summary.data.tx_count > 0);
  const note = fees.data?.note ?? summary.data?.note;

  return (
    <div className="screen-in flex flex-col gap-5">
      {/* Фільтр періоду — один ряд над усім, що він скоупить */}
      <div
        role="radiogroup"
        aria-label={t('analytics.periodAria')}
        className="grid grid-cols-4 gap-1 rounded-lg border border-hairline bg-surface p-1"
      >
        {PERIODS.map((option) => {
          const active = period === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPeriod(option.id)}
              className={`capsule px-2 py-1.5 text-center transition-colors duration-100 ${
                active ? 'bg-raised text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>

      {!networkAllowed && <NetworkOffNote />}

      {/* Холодний старт бекенду (безкоштовний хостинг). */}
      <BackendWakingNote pending={networkAllowed && isLoading} />

      {networkAllowed && isError && (
        <ErrorNote
          onRetry={() => {
            void fees.refetch();
            void summary.refetch();
          }}
        >
          {t('analytics.backendDown')}
        </ErrorNote>
      )}

      {networkAllowed && isLoading && (
        <div className="flex flex-col gap-2">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-36 w-full" />
          <div className="skeleton h-36 w-full" />
        </div>
      )}

      {networkAllowed && !isLoading && !isError && !hasAnyData && (
        <>
          <EmptyState title={t('analytics.emptyTitle')} hint={t('analytics.emptyHint')} />
          {note !== undefined && <ServiceNote note={note} />}
        </>
      )}

      {networkAllowed && !isLoading && !isError && hasAnyData && (
        <div className={`flex flex-col gap-5 ${refreshing ? 'opacity-60' : ''}`}>
          {/* Stat-плитки: hero-число mono — плитки, не графіки */}
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t('analytics.feesTitle')}
              value={formatUsd(fees.data?.total_fees_usd ?? 0)}
            />
            <StatTile
              label={t('analytics.txCountTitle')}
              value={String(summary.data?.tx_count ?? 0)}
            />
          </div>

          {/* Комісії за часом */}
          {fees.data !== undefined && fees.data.timeline.length > 0 && (
            <section>
              <Eyebrow className="mb-2.5">{t('analytics.feesOverTime')}</Eyebrow>
              <Card className="p-3">
                <FeesTimeline points={fees.data.timeline} />
              </Card>
            </section>
          )}

          {/* Розподіл по мережах — категоріальні кольори мереж */}
          {fees.data !== undefined && fees.data.by_chain.length > 0 && (
            <section>
              <Eyebrow className="mb-2.5">{t('analytics.byChain')}</Eyebrow>
              <Card>
                <ChainBars byChain={fees.data.by_chain} />
              </Card>
            </section>
          )}

          {/* По категоріях — sequential-бурштин (magnitude) */}
          {summary.data !== undefined && summary.data.by_category.length > 0 && (
            <section>
              <Eyebrow className="mb-2.5">{t('analytics.byCategory')}</Eyebrow>
              <Card>
                <CategoryBars byCategory={summary.data.by_category} />
              </Card>
            </section>
          )}

          {note !== undefined && <ServiceNote note={note} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Плитки та примітки
// ---------------------------------------------------------------------------

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-hairline bg-surface p-3.5">
      <p
        className="truncate font-mono text-[22px] font-semibold leading-none tracking-tight text-ink tabular-nums"
        dir="ltr"
      >
        {value}
      </p>
      <p className="eyebrow mt-2">{label}</p>
    </div>
  );
}

/** Службова примітка бекенду (напр., EVM пропущено без ETHERSCAN_API_KEY). */
function ServiceNote({ note }: { note: string }) {
  return (
    <p className="font-mono text-[11px] leading-relaxed text-muted/80" dir="ltr">
      {note}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Таймлайн комісій: SVG-стовпчики, одна вісь, hover-тултип на кожен бар
// ---------------------------------------------------------------------------

/** Ціле «кругле» число зверху шкали: 1/2/5 × 10^k. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

/** Компактний підпис осі: $12 / $0.5 (без хвостів). */
function axisUsd(value: number): string {
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : 2;
  return `$${value.toFixed(digits).replace(/\.0+$/, '')}`;
}

interface Bucket {
  fromSec: number;
  toSec: number;
  usd: number;
}

/** Агрегує денні точки у ≤maxBars кошиків послідовних днів (90д/рік). */
function bucketize(points: FeePoint[], maxBars: number): Bucket[] {
  const perBucket = Math.ceil(points.length / maxBars);
  const buckets: Bucket[] = [];
  for (let i = 0; i < points.length; i += perBucket) {
    const slice = points.slice(i, i + perBucket);
    buckets.push({
      fromSec: slice[0].date,
      toSec: slice[slice.length - 1].date,
      usd: slice.reduce((sum, p) => sum + p.fees_usd, 0),
    });
  }
  return buckets;
}

/** Стовпчик із закругленням 4px ЛИШЕ зверху, квадратний біля осі. */
function topRoundedBar(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

function FeesTimeline({ points }: { points: FeePoint[] }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);

  // Геометрія: ширина картки попапа фіксована (380 − page 40 − card 34).
  const width = 306;
  const gutter = 30; // ліва канавка під підписи осі
  const plotW = width - gutter;
  const plotH = 96;
  const axisBand = 16; // смуга підписів X всередині контейнера, не обрізається
  const height = plotH + axisBand;

  const buckets = useMemo(() => bucketize(points, 44), [points]);
  const locale = getActiveLocale();
  const dayLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
    [locale],
  );

  const max = niceMax(Math.max(...buckets.map((b) => b.usd)));
  const slot = plotW / buckets.length;
  const gap = 2;
  const barW = Math.max(1.5, Math.min(24, slot - gap));
  const y = (usd: number) => plotH - (usd / max) * (plotH - 8);

  const peakIndex = buckets.reduce((best, b, i) => (b.usd > buckets[best].usd ? i : best), 0);
  const bucketLabel = (b: Bucket) =>
    b.fromSec === b.toSec
      ? dayLabel.format(b.fromSec * 1000)
      : `${dayLabel.format(b.fromSec * 1000)} – ${dayLabel.format(b.toSec * 1000)}`;

  const hovered = hover !== null ? buckets[hover] : null;

  return (
    <div className="relative" dir="ltr">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('analytics.feesChartAria')}
        onPointerLeave={() => setHover(null)}
      >
        {/* Ледь помітна сітка: суцільні hairline на 0 / ½ / max */}
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={gutter}
            x2={width}
            y1={y(max * f)}
            y2={y(max * f)}
            stroke="var(--color-hairline)"
            strokeWidth="1"
            opacity={f === 0 ? 1 : 0.55}
          />
        ))}
        {/* Підписи однієї осі — текстові токени, tabular-nums */}
        {[0.5, 1].map((f) => (
          <text
            key={f}
            x={gutter - 5}
            y={y(max * f) + 3}
            textAnchor="end"
            className="fill-[var(--color-muted)] font-mono tabular-nums"
            fontSize="9"
          >
            {axisUsd(max * f)}
          </text>
        ))}

        {/* Бари: тонкі, закруглення 4px лише зверху, gap 2px */}
        {buckets.map((bucket, i) => {
          const x = gutter + i * slot + (slot - barW) / 2;
          const barY = y(bucket.usd);
          const h = plotH - barY;
          if (bucket.usd <= 0 || h < 0.5) return null;
          return (
            <path
              key={bucket.fromSec}
              d={topRoundedBar(x, barY, barW, h, 4)}
              fill="var(--color-accent)"
              opacity={hover === null || hover === i ? 1 : 0.45}
            />
          );
        })}

        {/* Пряме підписування піка (значення читається і без тултипа) */}
        {buckets[peakIndex].usd > 0 && hover === null && (
          <text
            x={Math.min(
              Math.max(gutter + peakIndex * slot + slot / 2, gutter + 24),
              width - 24,
            )}
            y={Math.max(y(buckets[peakIndex].usd) - 4, 8)}
            textAnchor="middle"
            className="fill-[var(--color-ink)] font-mono tabular-nums"
            fontSize="9.5"
          >
            {axisUsd(buckets[peakIndex].usd)}
          </text>
        )}

        {/* Підписи X: перший і останній кошик */}
        <text
          x={gutter}
          y={height - 3}
          className="fill-[var(--color-muted)] font-mono"
          fontSize="9"
        >
          {dayLabel.format(buckets[0].fromSec * 1000)}
        </text>
        <text
          x={width}
          y={height - 3}
          textAnchor="end"
          className="fill-[var(--color-muted)] font-mono"
          fontSize="9"
        >
          {dayLabel.format(buckets[buckets.length - 1].toSec * 1000)}
        </text>

        {/* Хіт-зони на весь слот (ширші за бар) — hover/focus тултип */}
        {buckets.map((bucket, i) => (
          <rect
            key={`hit-${bucket.fromSec}`}
            x={gutter + i * slot}
            y={0}
            width={slot}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${bucketLabel(bucket)}: ${formatUsd(bucket.usd)}`}
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {/* Тултип: дата + сума; значення — головне, підпис — вторинний */}
      {hovered !== null && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-y-1 rounded-[7px] border border-hairline bg-raised px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${Math.min(Math.max(((gutter + (hover + 0.5) * slot) / width) * 100, 18), 82)}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <p className="whitespace-nowrap font-mono text-xs font-semibold text-ink tabular-nums" dir="ltr">
            {formatUsd(hovered.usd)}
          </p>
          <p className="whitespace-nowrap font-mono text-[10px] text-muted" dir="ltr">
            {bucketLabel(hovered)}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Горизонтальні бари: назва рядка — прямий підпис, значення на ≤4 найбільших
// ---------------------------------------------------------------------------

interface HBarRow {
  key: string;
  label: string;
  color: string;
  usd: number;
  /** Додатковий тултип (native title + aria). */
  detail: string;
}

function HBars({ rows }: { rows: HBarRow[] }) {
  const max = Math.max(...rows.map((r) => r.usd), 0);
  // Пряме підписування значень лише на ≤4 найбільших рядках.
  const labeled = new Set(
    [...rows].sort((a, b) => b.usd - a.usd).slice(0, 4).map((r) => r.key),
  );
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.key} title={row.detail} aria-label={row.detail}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-ink">{row.label}</span>
            {labeled.has(row.key) && (
              <span className="font-mono text-xs text-muted tabular-nums" dir="ltr">
                {formatUsd(row.usd)}
              </span>
            )}
          </div>
          <div className="h-2 w-full rounded-[4px] bg-raised/70" dir="ltr">
            <div
              className="h-2 rounded-e-[4px] rounded-s-none"
              style={{
                width: `${max > 0 ? Math.max((row.usd / max) * 100, row.usd > 0 ? 2 : 0) : 0}%`,
                backgroundColor: row.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChainBars({
  byChain,
}: {
  byChain: { chain: Chain; fees_usd: number; tx_count: number }[];
}) {
  const { t } = useTranslation();
  const byId = new Map(byChain.map((entry) => [entry.chain, entry]));
  // Фіксований порядок реєстру мереж — колір іде за мережею, не за рангом.
  const rows: HBarRow[] = CHAIN_IDS.filter((id) => byId.has(id)).map((id) => {
    const entry = byId.get(id) as (typeof byChain)[number];
    return {
      key: id,
      label: CHAINS[id].label,
      color: CHAINS[id].color,
      usd: entry.fees_usd,
      detail: `${CHAINS[id].label}: ${formatUsd(entry.fees_usd)} · ${t('analytics.txShort', { n: entry.tx_count })}`,
    };
  });
  return <HBars rows={rows} />;
}

function CategoryBars({
  byCategory,
}: {
  byCategory: { category: TxCategory; tx_count: number; volume_usd: number }[];
}) {
  const { t } = useTranslation();
  // Magnitude: сортуємо за обсягом, sequential-бурштин темніє зі спаданням.
  const sorted = [...byCategory].sort((a, b) => b.volume_usd - a.volume_usd);
  const rows: HBarRow[] = sorted.map((entry, index) => {
    const label =
      CATEGORY_LABEL_KEY[entry.category] !== undefined
        ? t(CATEGORY_LABEL_KEY[entry.category])
        : entry.category;
    return {
      key: entry.category,
      label,
      color: AMBER_RAMP[Math.min(index, AMBER_RAMP.length - 1)],
      usd: entry.volume_usd,
      detail: `${label}: ${formatUsd(entry.volume_usd)} · ${t('analytics.txShort', { n: entry.tx_count })}`,
    };
  });
  return <HBars rows={rows} />;
}
