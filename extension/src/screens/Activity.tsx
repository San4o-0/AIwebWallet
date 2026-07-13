/**
 * Активність: сегмент «Історія | Аналітика» (нижнє меню не розширюємо).
 * Історія — транзакції з людськими описами (F3.6, F4.4);
 * Аналітика — графіки комісій/зведення (src/screens/Analytics.tsx).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NetworkOffNote, useNetworkAllowed } from '@/src/components/consent';
import { IconActivity, IconGrid } from '@/src/components/icons';
import { Card, EmptyState, ErrorNote, ScreenHeader } from '@/src/components/ui';
import Analytics from '@/src/screens/Analytics';
import TxDetail, { CATEGORY_ICON, CATEGORY_LABEL_KEY } from '@/src/screens/TxDetail';
import { fetchHistory } from '@/src/lib/api';
import type { HistoryEntry } from '@/src/lib/api-types';
import { CHAINS } from '@/src/lib/chains';
import { formatRelativeTime, formatUsd } from '@/src/lib/format';
import { useWalletStore } from '@/src/store/wallet';

type ActivityView = 'history' | 'analytics';

export default function Activity() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const networkAllowed = useNetworkAllowed();
  const [view, setView] = useState<ActivityView>('history');
  const [selectedTx, setSelectedTx] = useState<HistoryEntry | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['history', account?.addresses.evm],
    queryFn: () => fetchHistory(account?.addresses.evm ?? ''),
    // Історія читається за адресою — в офлайн-режимі запит не ставиться.
    enabled: account !== null && view === 'history' && networkAllowed,
  });

  const items = data?.items ?? [];

  // Деталь обраної транзакції заміщує список (сегмент/нижнє меню лишаються).
  if (selectedTx !== null) {
    return <TxDetail tx={selectedTx} onBack={() => setSelectedTx(null)} />;
  }

  return (
    <div className="screen-in flex flex-col gap-5 p-5 pb-24">
      <ScreenHeader eyebrow={t('activity.eyebrow')} title={t('activity.title')} />

      {/* Сегмент «Історія | Аналітика» — нижнє меню не розширюємо */}
      <div
        role="tablist"
        aria-label={t('activity.viewAria')}
        className="grid grid-cols-2 gap-1 rounded-lg border border-hairline bg-surface p-1"
      >
        {(
          [
            { id: 'history', label: t('activity.viewHistory') },
            { id: 'analytics', label: t('activity.viewAnalytics') },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={view === option.id}
            onClick={() => setView(option.id)}
            className={`rounded-[7px] px-3 py-1.5 text-sm font-medium transition-colors duration-100 ${
              view === option.id ? 'bg-raised text-accent' : 'text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {view === 'analytics' && <Analytics />}

      {view === 'history' && (
        <>
      {!networkAllowed && <NetworkOffNote />}

      {networkAllowed && isLoading && (
        <div className="flex flex-col gap-2">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      )}

      {networkAllowed && isError && (
        <ErrorNote onRetry={() => void refetch()}>{t('activity.backendDown')}</ErrorNote>
      )}

      {networkAllowed && !isLoading && !isError && items.length === 0 && (
        <EmptyState
          icon={<IconActivity size={22} />}
          title={t('activity.emptyTitle')}
          hint={t('activity.emptyHint')}
        />
      )}

      {items.length > 0 && (
        <Card className="stagger-rise p-0">
          {items.map((tx, index) => {
            const Icon = CATEGORY_ICON[tx.category] ?? IconGrid;
            return (
              <button
                key={tx.id}
                type="button"
                onClick={() => setSelectedTx(tx)}
                className={`flex w-full items-start gap-3 px-4 py-3.5 text-start transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-raised text-muted">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="eyebrow">
                      {CATEGORY_LABEL_KEY[tx.category] !== undefined
                        ? t(CATEGORY_LABEL_KEY[tx.category])
                        : tx.category}{' '}
                      · {CHAINS[tx.chain]?.label ?? tx.chain}
                    </span>
                    {tx.amountUsd !== null && (
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums ${
                          tx.amountUsd >= 0 ? 'text-positive' : 'text-ink'
                        }`}
                      >
                        {tx.amountUsd >= 0 ? '+' : ''}
                        {formatUsd(tx.amountUsd)}
                      </span>
                    )}
                  </div>
                  {/* Людський опис — з бекенд-індексера + AI (F4.4) */}
                  <p className="mt-1 text-[13px] leading-snug text-ink">{tx.description}</p>
                  <p className="mt-1.5 text-xs text-muted/80">
                    {formatRelativeTime(tx.timestamp)} ·{' '}
                    <span className="font-mono text-[11px]" dir="ltr">
                      {tx.hash}
                    </span>
                    {tx.status === 'failed' && (
                      <span className="ms-1.5 font-medium text-danger">
                        {t('activity.statusFailed')}
                      </span>
                    )}
                    {tx.status === 'pending' && (
                      <span className="ms-1.5 font-medium text-amber">
                        {t('activity.statusPending')}
                      </span>
                    )}
                  </p>
                </div>
              </button>
            );
          })}
        </Card>
      )}
        </>
      )}
    </div>
  );
}
