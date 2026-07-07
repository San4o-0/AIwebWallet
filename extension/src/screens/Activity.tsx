/** Історія транзакцій з людськими описами (F3.6, F4.4). */
import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';

import {
  IconActivity,
  IconCheck,
  IconGrid,
  IconSend,
  IconSparkle,
  IconSwap,
  type IconProps,
} from '@/src/components/icons';
import { Card, EmptyState, ErrorNote, ScreenHeader } from '@/src/components/ui';
import { fetchHistory } from '@/src/lib/api';
import type { TxCategory } from '@/src/lib/api-types';
import { CHAINS } from '@/src/lib/chains';
import { formatRelativeTime, formatUsd } from '@/src/lib/format';
import { useWalletStore } from '@/src/store/wallet';

const CATEGORY_LABEL: Record<TxCategory, string> = {
  transfer: 'Переказ',
  swap: 'Своп',
  approve: 'Дозвіл',
  mint: 'Mint',
  dapp: 'dApp',
};

const CATEGORY_ICON: Record<TxCategory, ComponentType<IconProps>> = {
  transfer: IconSend,
  swap: IconSwap,
  approve: IconCheck,
  mint: IconSparkle,
  dapp: IconGrid,
};

export default function Activity() {
  const account = useWalletStore((s) => s.account);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['history', account?.addresses.evm],
    queryFn: () => fetchHistory(account?.addresses.evm ?? ''),
    enabled: account !== null,
  });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-5 p-5 pb-24">
      <ScreenHeader eyebrow="Історія" title="Активність" />

      {isLoading && (
        <div className="flex flex-col gap-2">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      )}

      {isError && (
        <ErrorNote onRetry={() => void refetch()}>
          Бекенд не відповідає — історію не завантажено.
        </ErrorNote>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <EmptyState
          icon={<IconActivity size={22} />}
          title="Транзакцій поки немає"
          hint="Щойно надішлете чи отримаєте кошти — записи з поясненнями з'являться тут."
        />
      )}

      {items.length > 0 && (
        <Card className="p-0">
          {items.map((tx, index) => {
            const Icon = CATEGORY_ICON[tx.category] ?? IconGrid;
            return (
              <div
                key={tx.id}
                className={`flex items-start gap-3 px-4 py-3.5 ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-raised text-muted">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="eyebrow">
                      {CATEGORY_LABEL[tx.category] ?? tx.category} ·{' '}
                      {CHAINS[tx.chain]?.label ?? tx.chain}
                    </span>
                    {tx.amountUsd !== null && (
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums ${
                          tx.amountUsd >= 0 ? 'text-sage' : 'text-ink'
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
                    <span className="font-mono text-[11px]">{tx.hash}</span>
                    {tx.status === 'failed' && (
                      <span className="ml-1.5 font-medium text-terra">невдала</span>
                    )}
                    {tx.status === 'pending' && (
                      <span className="ml-1.5 font-medium text-amber">в обробці</span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
