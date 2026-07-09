/**
 * Детальний перегляд однієї транзакції (Активність → Історія → рядок).
 * Локальний оверлей-екран усередині Activity: шапка з категорією/мережею,
 * велика сума, статус-капсула, людський AI-опис, поля (мережа, напрям,
 * абсолютна дата/час, хеш із копіюванням) і вихід у блок-експлорер.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';

import {
  IconCheck,
  IconCopy,
  IconChevronLeft,
  IconExternal,
  IconGrid,
  IconSend,
  IconSparkle,
  IconSwap,
  type IconProps,
} from '@/src/components/icons';
import { ChainIcon } from '@/src/components/chain-icons';
import { Card, Eyebrow } from '@/src/components/ui';
import type { HistoryEntry, TxCategory, TxDirection, TxStatus } from '@/src/lib/api-types';
import { CHAINS, explorerTxUrl } from '@/src/lib/chains';
import { formatDateTime, formatUsd } from '@/src/lib/format';

/** i18n-ключі підписів категорій транзакцій (спільні зі списком Історії). */
export const CATEGORY_LABEL_KEY: Record<TxCategory, string> = {
  transfer: 'category.transfer',
  swap: 'category.swap',
  approve: 'category.approve',
  mint: 'category.mint',
  dapp: 'category.dapp',
};

export const CATEGORY_ICON: Record<TxCategory, ComponentType<IconProps>> = {
  transfer: IconSend,
  swap: IconSwap,
  approve: IconCheck,
  mint: IconSparkle,
  dapp: IconGrid,
};

const DIRECTION_LABEL_KEY: Record<TxDirection, string> = {
  in: 'txDetail.dirIn',
  out: 'txDetail.dirOut',
  self: 'txDetail.dirSelf',
};

/** Статус-капсула: підпис-ключ + токени кольору дизайн-системи. */
const STATUS_STYLE: Record<TxStatus, { key: string; className: string }> = {
  confirmed: {
    key: 'txDetail.statusConfirmed',
    className: 'border-positive/40 bg-positive/10 text-positive',
  },
  pending: {
    key: 'txDetail.statusPending',
    className: 'border-amber/40 bg-amber/10 text-amber',
  },
  failed: {
    key: 'txDetail.statusFailed',
    className: 'border-danger/40 bg-danger/10 text-danger',
  },
};

/** Рядок поля: eyebrow-підпис ліворуч, значення праворуч. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-hairline px-4 py-3 first:border-t-0">
      <span className="eyebrow shrink-0 pt-0.5">{label}</span>
      <span className="min-w-0 text-end text-sm text-ink">{children}</span>
    </div>
  );
}

export default function TxDetail({ tx, onBack }: { tx: HistoryEntry; onBack: () => void }) {
  const { t } = useTranslation();
  const chain = CHAINS[tx.chain];
  const Icon = CATEGORY_ICON[tx.category] ?? IconGrid;
  const status = STATUS_STYLE[tx.status];

  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(tx.hash);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setCopyError(false);
    }, 2000);
  };

  const openExplorer = () => {
    void browser.tabs.create({ url: explorerTxUrl(tx.chain, tx.hash) });
  };

  const categoryLabel =
    CATEGORY_LABEL_KEY[tx.category] !== undefined
      ? t(CATEGORY_LABEL_KEY[tx.category])
      : tx.category;

  const hasAmount = tx.amountUsd !== null;
  const isPositive = hasAmount && tx.amountUsd! > 0;
  const sign = isPositive ? '+' : hasAmount ? '−' : '';

  return (
    <div className="flex flex-col gap-5 p-5 pb-24">
      <header>
        <button
          type="button"
          onClick={onBack}
          className="-ms-2 flex items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <IconChevronLeft size={16} className="rtl:-scale-x-100" />
          {t('common.back')}
        </button>
      </header>

      <section className="flex flex-col gap-5 animate-rise">
        <h1 className="sr-only">{t('txDetail.title')}</h1>

        {/* Шапка: категорія · мережа, велика сума, статус */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-raised text-muted">
                <Icon size={16} />
              </span>
              <span className="eyebrow">
                {categoryLabel} · {chain.label}
              </span>
            </span>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
              style={{ borderColor: `${chain.color}59`, color: chain.color }}
            >
              <ChainIcon chain={tx.chain} size={13} />
              {chain.symbol}
            </span>
          </div>

          <div className="mt-4 flex items-center gap-2.5">
            {hasAmount ? (
              <p
                className={`font-display text-2xl font-semibold tabular-nums ${
                  isPositive ? 'text-positive' : 'text-ink'
                }`}
                dir="ltr"
              >
                {sign}
                {formatUsd(Math.abs(tx.amountUsd!))}
              </p>
            ) : (
              <p className="font-display text-2xl font-semibold text-ink">{categoryLabel}</p>
            )}
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${status.className}`}
            >
              {t(status.key)}
            </span>
          </div>
        </div>

        {/* Людський AI-опис — головна цінність екрана */}
        <div className="rounded-[10px] border border-hairline bg-surface p-4">
          <Eyebrow className="mb-1.5">{t('txDetail.description')}</Eyebrow>
          <p className="text-sm leading-relaxed text-ink">{tx.description}</p>
        </div>

        {/* Поля */}
        <Card className="p-0">
          <DetailRow label={t('txDetail.network')}>
            <span className="inline-flex items-center gap-1.5">
              <ChainIcon chain={tx.chain} size={15} className="shrink-0" />
              {chain.label}
            </span>
          </DetailRow>
          <DetailRow label={t('txDetail.direction')}>{t(DIRECTION_LABEL_KEY[tx.direction])}</DetailRow>
          <DetailRow label={t('txDetail.dateTime')}>{formatDateTime(tx.timestamp)}</DetailRow>
        </Card>

        {/* Хеш транзакції з копіюванням */}
        <div className="rounded-[10px] border border-hairline bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <Eyebrow>{t('txDetail.hash')}</Eyebrow>
            <button
              type="button"
              onClick={() => void copyHash()}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition-colors ${
                copied ? 'text-positive' : 'text-muted hover:text-accent'
              }`}
            >
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copied ? t('txDetail.copied') : t('txDetail.copy')}
            </button>
          </div>
          <p className="mt-2 break-all font-mono text-[12px] leading-relaxed text-ink" dir="ltr">
            {tx.hash}
          </p>
          {copyError && <p className="mt-1.5 text-xs text-danger">{t('receive.clipboardError')}</p>}
        </div>

        {/* Вихід у блок-експлорер (зовнішній сервіс) */}
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <Eyebrow>{t('receive.externalService')}</Eyebrow>
          </div>
          <button
            type="button"
            onClick={openExplorer}
            className="flex w-full items-center justify-between rounded-xl border border-hairline bg-raised px-3.5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent/50"
          >
            {t('txDetail.viewExplorer')}
            <IconExternal size={15} className="text-muted" />
          </button>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('txDetail.externalService')}</p>
        </div>
      </section>
    </div>
  );
}
