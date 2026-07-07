/**
 * Головний екран: агрегований баланс у USD, мережі та токени (F2.1–F2.3).
 * Дані — TanStack Query → src/lib/api.ts (з fallback на моки).
 */
import { useQuery } from '@tanstack/react-query';

import { Card, EmptyState, ScreenTitle, Spinner } from '@/src/components/ui';
import { fetchPortfolio } from '@/src/lib/api';
import type { TokenBalance } from '@/src/lib/api-types';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { formatUsd, shortenAddress } from '@/src/lib/format';
import { useWalletStore } from '@/src/store/wallet';

export default function Home() {
  const account = useWalletStore((s) => s.account);
  const lock = useWalletStore((s) => s.lock);

  const { data: portfolio, isLoading } = useQuery({
    queryKey: ['portfolio', account?.addresses.evm],
    queryFn: () =>
      fetchPortfolio({
        addresses: {
          evm: account !== null ? [account.addresses.evm] : [],
          solana: account !== null && account.addresses.solana !== '' ? [account.addresses.solana] : [],
          bitcoin: account !== null && account.addresses.bitcoin !== '' ? [account.addresses.bitcoin] : [],
        },
      }),
    enabled: account !== null,
  });

  const byChain = new Map<Chain, TokenBalance[]>();
  for (const token of portfolio?.tokens ?? []) {
    const list = byChain.get(token.chain) ?? [];
    list.push(token);
    byChain.set(token.chain, list);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div>
          <ScreenTitle>{account?.name ?? 'Гаманець'}</ScreenTitle>
          {account !== null && (
            <p className="font-mono text-xs text-zinc-500">
              {shortenAddress(account.addresses.evm)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void lock()}
          className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          title="Заблокувати"
        >
          Заблокувати
        </button>
      </header>

      <Card className="text-center">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Загальний баланс</p>
        {isLoading ? (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        ) : (
          <p className="mt-1 text-3xl font-bold tracking-tight text-zinc-50">
            {formatUsd(portfolio?.totalUsd ?? 0)}
          </p>
        )}
      </Card>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Мережі
        </h2>
        <div className="flex flex-col gap-1.5">
          {CHAIN_IDS.map((chain) => {
            const tokens = byChain.get(chain) ?? [];
            const chainUsd = tokens.reduce((sum, t) => sum + t.usdValue, 0);
            return (
              <div
                key={chain}
                className="flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-3 py-2"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: CHAINS[chain].color }}
                  />
                  <span className="text-sm text-zinc-200">{CHAINS[chain].label}</span>
                </div>
                <span className="text-sm text-zinc-400">{formatUsd(chainUsd)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Токени
        </h2>
        {!isLoading && (portfolio?.tokens?.length ?? 0) === 0 && (
          <EmptyState>Токенів поки немає</EmptyState>
        )}
        <div className="flex flex-col gap-1.5">
          {(portfolio?.tokens ?? []).map((token) => (
            <div
              key={`${token.chain}-${token.symbol}-${token.contractAddress ?? 'native'}`}
              className="flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5"
            >
              <div>
                <p className="text-sm font-medium text-zinc-100">{token.symbol}</p>
                <p className="text-xs text-zinc-500">
                  {CHAINS[token.chain].label}
                  {token.isNative ? '' : ' · токен'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-zinc-100">{token.amount}</p>
                <p className="text-xs text-zinc-500">{formatUsd(token.usdValue)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
