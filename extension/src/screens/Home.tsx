/**
 * Головний екран: агрегований баланс у USD, мережі та токени (F2.1–F2.3).
 * Дані — TanStack Query → src/lib/api.ts (з fallback на моки).
 *
 * Підпис дизайну: велика серифна сума → латунна hairline 1px →
 * small-caps підпис «Загальний баланс».
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { BackendWakingNote } from '@/src/components/backend-status';
import { ChainIcon } from '@/src/components/chain-icons';
import { NetworkOffNote, useNetworkAllowed } from '@/src/components/consent';
import {
  IconChevronDown,
  IconLock,
  IconQr,
  IconReceive,
  IconSend,
} from '@/src/components/icons';
import { Card, ErrorNote, Eyebrow, EmptyState, IconButton } from '@/src/components/ui';
import { fetchPortfolio } from '@/src/lib/api';
import type { TokenBalance } from '@/src/lib/api-types';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { formatUsd, shortenAddress } from '@/src/lib/format';
import { MAX_WALLETS } from '@/src/lib/vault-storage';
import { findActiveWallet, useWalletStore } from '@/src/store/wallet';

export default function Home() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const lock = useWalletStore((s) => s.lock);
  const setScreen = useWalletStore((s) => s.setScreen);
  // Офлайн-режим (немає згоди на передачу даних): адреси на бекенд не йдуть,
  // тож запит навіть не ставиться в чергу — і замість цифр показуємо «—»,
  // а не «$0.00»: нуль був би брехнею про баланс.
  const networkAllowed = useNetworkAllowed();

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
    enabled: account !== null && networkAllowed,
  });

  const byChain = new Map<Chain, TokenBalance[]>();
  for (const token of portfolio?.tokens ?? []) {
    const list = byChain.get(token.chain) ?? [];
    list.push(token);
    byChain.set(token.chain, list);
  }

  return (
    <div className="screen-in flex flex-col gap-6 p-5 pb-24">
      <header className="flex items-start justify-between gap-3">
        <WalletSwitcher />
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
        {isLoading && networkAllowed ? (
          <div className="skeleton h-12 w-48" />
        ) : (
          <p
            key={portfolio?.updatedAt}
            className="figures-oldstyle animate-rise font-display text-[40px] font-semibold leading-none tracking-tight text-ink"
          >
            {networkAllowed ? formatUsd(portfolio?.totalUsd ?? 0) : '—'}
          </p>
        )}
        <div className="mt-4 h-px w-full bg-accent/60" aria-hidden />
        <Eyebrow className="mt-2">{t('home.totalBalance')}</Eyebrow>
      </section>

      {!networkAllowed && <NetworkOffNote />}

      {/* Холодний старт безкоштовного хостингу: замість спінера, що крутиться
          хвилину «без причини», — чесне пояснення (з'являється лише коли
          завантаження справді затягнулось). */}
      <BackendWakingNote pending={networkAllowed && isLoading} />

      {networkAllowed && isError && (
        <ErrorNote onRetry={() => void refetch()}>
          {t('home.backendDownBalances')}
        </ErrorNote>
      )}

      {/* Швидкі дії */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setScreen('send')}
          className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-bg transition-[background-color,transform] duration-100 hover:bg-accent-bright active:scale-[0.98]"
        >
          <IconSend size={17} />
          {t('home.send')}
        </button>
        <button
          type="button"
          onClick={() => setScreen('receive')}
          className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-raised px-4 py-3 text-sm font-semibold text-ink transition-[border-color,transform] duration-100 hover:border-accent/50 active:scale-[0.98]"
        >
          <IconReceive size={17} />
          {t('home.receive')}
        </button>
      </div>

      <section>
        <Eyebrow className="mb-2.5">{t('common.networks')}</Eyebrow>
        <Card className="stagger-rise p-0">
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
                {isLoading && networkAllowed ? (
                  <span className="skeleton h-3.5 w-14" />
                ) : (
                  <span className="text-sm tabular-nums text-muted">
                    {networkAllowed ? formatUsd(chainUsd) : '—'}
                  </span>
                )}
              </div>
            );
          })}
        </Card>
      </section>

      <section>
        <Eyebrow className="mb-2.5">{t('home.assets')}</Eyebrow>
        {/* Офлайн-режим: активів не показуємо взагалі — причину вже пояснив
            NetworkOffNote вище, «порожньо» тут було б неправдою. */}
        {!networkAllowed && (
          <EmptyState title={t('consent.offlineTitle')} hint={t('consent.offlineHint')} />
        )}
        {networkAllowed && isLoading && (
          <div className="flex flex-col gap-2">
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
          </div>
        )}
        {networkAllowed && !isLoading && (portfolio?.tokens?.length ?? 0) === 0 && (
          <EmptyState title={t('home.noAssetsTitle')} hint={t('home.noAssetsHint')} />
        )}
        {networkAllowed && !isLoading && (portfolio?.tokens?.length ?? 0) > 0 && (
          <Card className="stagger-rise p-0">
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

// ---------------------------------------------------------------------------
// Перемикач гаманців у шапці: тап по назві → випадайка з усіма гаманцями
// (multi-vault) і «Додати гаманець». Перемикання блокує сесію → екран Unlock
// паролем нового гаманця (логіка в store.switchWallet).
// ---------------------------------------------------------------------------

function WalletSwitcher() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const switchWallet = useWalletStore((s) => s.switchWallet);
  const startAddWallet = useWalletStore((s) => s.startAddWallet);
  const activeWallet = findActiveWallet(wallets, activeWalletId);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="group flex min-w-0 items-center gap-1.5 text-start"
      >
        <span className="min-w-0">
          {activeWallet !== null && (
            <Eyebrow className="mb-0.5 truncate">{activeWallet.name}</Eyebrow>
          )}
          <span className="block truncate text-sm font-semibold text-ink">
            {account?.name ?? t('home.walletFallback')}
          </span>
          {account !== null && (
            <span className="mt-0.5 block font-mono text-xs text-muted" dir="ltr">
              {shortenAddress(account.addresses.evm)}
            </span>
          )}
        </span>
        <IconChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform group-hover:text-ink ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <>
          {/* Прозорий бекдроп: клік поза списком закриває його */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="listbox"
            className="animate-rise absolute start-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-xl border border-hairline bg-raised shadow-xl"
          >
            {wallets.map((wallet, index) => {
              const active = wallet.id === activeWalletId;
              return (
                <button
                  key={wallet.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    if (active) {
                      setOpen(false);
                      return;
                    }
                    // Успішне перемикання веде на Unlock (компонент зникне);
                    // при помилці лишаємось і показуємо текст під списком.
                    void switchWallet(wallet.id).then((err) => {
                      if (err !== null) setError(err);
                    });
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-start transition-colors hover:bg-surface ${
                    index > 0 ? 'border-t border-hairline' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {wallet.name}
                    </span>
                    {wallet.primaryEvmAddress !== null && (
                      <span className="block truncate font-mono text-[11px] text-muted" dir="ltr">
                        {shortenAddress(wallet.primaryEvmAddress)}
                      </span>
                    )}
                  </span>
                  {active && (
                    <span className="shrink-0 text-[11px] font-medium text-accent">
                      {t('settings.walletActive')}
                    </span>
                  )}
                </button>
              );
            })}
            {wallets.length < MAX_WALLETS ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  startAddWallet();
                }}
                className="flex w-full items-center gap-2 border-t border-hairline px-3.5 py-2.5 text-start text-sm font-medium text-accent transition-colors hover:bg-surface"
              >
                <span aria-hidden>+</span>
                {t('settings.addWallet')}
              </button>
            ) : (
              <p className="border-t border-hairline px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                {t('errors.walletLimit', { max: MAX_WALLETS })}
              </p>
            )}
            {error !== null && (
              <p className="border-t border-hairline px-3.5 py-2 text-xs text-danger">{error}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
