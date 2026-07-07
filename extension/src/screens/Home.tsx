/**
 * Головний екран: агрегований баланс у USD, мережі та токени (F2.1–F2.3).
 * Дані — TanStack Query → src/lib/api.ts (з fallback на моки).
 *
 * Підпис дизайну: велика серифна сума → латунна hairline 1px →
 * small-caps підпис «Загальний баланс».
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { ChainIcon } from '@/src/components/chain-icons';
import { IconLock, IconQr, IconReceive, IconSend } from '@/src/components/icons';
import { Card, ErrorNote, Eyebrow, EmptyState, IconButton } from '@/src/components/ui';
import { fetchPortfolio } from '@/src/lib/api';
import type { TokenBalance } from '@/src/lib/api-types';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { formatUsd, shortenAddress } from '@/src/lib/format';
import { findActiveWallet, useWalletStore } from '@/src/store/wallet';

export default function Home() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const lock = useWalletStore((s) => s.lock);
  const setScreen = useWalletStore((s) => s.setScreen);
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const activeWallet = findActiveWallet(wallets, activeWalletId);

  const { data: portfolio, isLoading, isError, refetch } = useQuery({
    queryKey: ['portfolio', account?.addresses.evm],
    queryFn: () =>
      fetchPortfolio({
        addresses: {
          evm: account !== null ? [account.addresses.evm] : [],
          solana: account !== null && account.addresses.solana !== '' ? [account.addresses.solana] : [],
          bitcoin: account !== null && account.addresses.bitcoin !== '' ? [account.addresses.bitcoin] : [],
          tron: account !== null && account.addresses.tron !== '' ? [account.addresses.tron] : [],
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
    <div className="flex flex-col gap-6 p-5 pb-24">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Назва гаманця (multi-vault) — перемикання у «Ще» → «Гаманці» */}
          {activeWallet !== null && (
            <Eyebrow className="mb-0.5 truncate">{activeWallet.name}</Eyebrow>
          )}
          <p className="truncate text-sm font-semibold text-ink">
            {account?.name ?? t('home.walletFallback')}
          </p>
          {account !== null && (
            <p className="mt-0.5 font-mono text-xs text-muted" dir="ltr">
              {shortenAddress(account.addresses.evm)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <IconButton label={t('home.receiveAddresses')} onClick={() => setScreen('receive')}>
            <IconQr size={17} />
          </IconButton>
          <IconButton label={t('home.lockWallet')} onClick={() => void lock()}>
            <IconLock size={17} />
          </IconButton>
        </div>
      </header>

      {/* Підпис дизайну: серифна сума + латунна hairline + eyebrow */}
      <section aria-label={t('home.totalBalance')}>
        {isLoading ? (
          <div className="skeleton h-12 w-48" />
        ) : (
          <p
            key={portfolio?.updatedAt}
            className="figures-oldstyle animate-rise font-display text-[40px] font-semibold leading-none tracking-tight text-ink"
          >
            {formatUsd(portfolio?.totalUsd ?? 0)}
          </p>
        )}
        <div className="mt-4 h-px w-full bg-brass/60" aria-hidden />
        <Eyebrow className="mt-2">{t('home.totalBalance')}</Eyebrow>
      </section>

      {isError && (
        <ErrorNote onRetry={() => void refetch()}>
          {t('home.backendDownBalances')}
        </ErrorNote>
      )}

      {/* Швидкі дії */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setScreen('send')}
          className="flex items-center justify-center gap-2 rounded-xl bg-brass px-4 py-3 text-sm font-semibold text-bg transition-colors hover:bg-brass-bright"
        >
          <IconSend size={17} />
          {t('home.send')}
        </button>
        <button
          type="button"
          onClick={() => setScreen('receive')}
          className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-raised px-4 py-3 text-sm font-semibold text-ink transition-colors hover:border-brass/50"
        >
          <IconReceive size={17} />
          {t('home.receive')}
        </button>
      </div>

      <section>
        <Eyebrow className="mb-2.5">{t('common.networks')}</Eyebrow>
        <Card className="p-0">
          {CHAIN_IDS.map((chain, index) => {
            const tokens = byChain.get(chain) ?? [];
            const chainUsd = tokens.reduce((sum, t) => sum + t.usdValue, 0);
            return (
              <div
                key={chain}
                className={`flex items-center justify-between px-4 py-2.5 ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <ChainIcon chain={chain} size={20} className="shrink-0" />
                  <span className="text-sm text-ink">{CHAINS[chain].label}</span>
                </div>
                {isLoading ? (
                  <span className="skeleton h-3.5 w-14" />
                ) : (
                  <span className="text-sm tabular-nums text-muted">{formatUsd(chainUsd)}</span>
                )}
              </div>
            );
          })}
        </Card>
      </section>

      <section>
        <Eyebrow className="mb-2.5">{t('home.assets')}</Eyebrow>
        {isLoading && (
          <div className="flex flex-col gap-2">
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
          </div>
        )}
        {!isLoading && (portfolio?.tokens?.length ?? 0) === 0 && (
          <EmptyState title={t('home.noAssetsTitle')} hint={t('home.noAssetsHint')} />
        )}
        {!isLoading && (portfolio?.tokens?.length ?? 0) > 0 && (
          <Card className="p-0">
            {(portfolio?.tokens ?? []).map((token, index) => (
              <div
                key={`${token.chain}-${token.symbol}-${token.contractAddress ?? 'native'}`}
                className={`flex items-center justify-between px-4 py-3 ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-ink">{token.symbol}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {CHAINS[token.chain].label}
                    {token.isNative ? '' : ` · ${t('home.tokenSuffix')}`}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-sm tabular-nums text-ink">{token.amount}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted">
                    {formatUsd(token.usdValue)}
                  </p>
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
