/** Історія транзакцій з людськими описами (F3.6, F4.4). */
import { useQuery } from '@tanstack/react-query';

import { EmptyState, ScreenTitle, Spinner } from '@/src/components/ui';
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

const CATEGORY_ICON: Record<TxCategory, string> = {
  transfer: '⇄',
  swap: '⟳',
  approve: '✓',
  mint: '✧',
  dapp: '⌘',
};

export default function Activity() {
  const account = useWalletStore((s) => s.account);

  const { data, isLoading } = useQuery({
    queryKey: ['history', account?.addresses.evm],
    queryFn: () => fetchHistory(account?.addresses.evm ?? ''),
    enabled: account !== null,
  });

  return (
    <div className="flex flex-col gap-3 p-4">
      <ScreenTitle>Активність</ScreenTitle>

      {isLoading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {!isLoading && (data?.items.length ?? 0) === 0 && (
        <EmptyState>Транзакцій поки немає</EmptyState>
      )}

      <div className="flex flex-col gap-2">
        {(data?.items ?? []).map((tx) => (
          <div
            key={tx.id}
            className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm text-zinc-300">
                {CATEGORY_ICON[tx.category]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-400">
                    {CATEGORY_LABEL[tx.category]} · {CHAINS[tx.chain].label}
                  </span>
                  {tx.amountUsd !== null && (
                    <span
                      className={`shrink-0 text-sm font-semibold ${
                        tx.amountUsd >= 0 ? 'text-emerald-400' : 'text-zinc-200'
                      }`}
                    >
                      {tx.amountUsd >= 0 ? '+' : ''}
                      {formatUsd(tx.amountUsd)}
                    </span>
                  )}
                </div>
                {/* Людський опис — з бекенд-індексера + AI (F4.4) */}
                <p className="mt-0.5 text-sm leading-snug text-zinc-200">{tx.description}</p>
                <p className="mt-1 text-xs text-zinc-600">
                  {formatRelativeTime(tx.timestamp)} · {tx.hash}
                  {tx.status === 'failed' && (
                    <span className="ml-1.5 text-red-400">невдала</span>
                  )}
                  {tx.status === 'pending' && (
                    <span className="ml-1.5 text-amber-400">в обробці</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
