/**
 * Екран розблокування паролем (F1.5).
 * Multi-vault: зверху — назва активного гаманця і перемикач, щоб розблокувати
 * інший гаманець (його паролем) без входу в поточний.
 */
import { useState } from 'react';

import { BrandMark, IconCheck, IconChevronDown } from '@/src/components/icons';
import { Button, Eyebrow, Field } from '@/src/components/ui';
import { shortenAddress } from '@/src/lib/format';
import { findActiveWallet, useWalletStore } from '@/src/store/wallet';

export default function Unlock() {
  const unlock = useWalletStore((s) => s.unlock);
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const switchWallet = useWalletStore((s) => s.switchWallet);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeWallet = findActiveWallet(wallets, activeWalletId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await unlock(password);
    if (result !== null) {
      setError(result);
      setBusy(false);
    }
  };

  const pick = async (walletId: string) => {
    setPickerOpen(false);
    if (walletId === activeWalletId) return;
    setPassword('');
    setError(null);
    const result = await switchWallet(walletId);
    if (result !== null) setError(result);
  };

  return (
    <form
      className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto p-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="animate-rise flex flex-col items-center">
        <BrandMark size={48} />
        <h1 className="mt-5 font-display text-[26px] font-semibold leading-none text-ink">
          З поверненням
        </h1>
        <div className="mt-4 h-px w-24 bg-brass/60" aria-hidden />
        <Eyebrow className="mt-2">AI Wallet</Eyebrow>
      </div>

      {/* Активний гаманець + перемикач на інші (пароль — у КОЖНОГО свій) */}
      {activeWallet !== null && (
        <div className="w-full">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            aria-label="Обрати гаманець для розблокування"
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-left transition-colors hover:border-brass/50"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink">
                {activeWallet.name}
              </span>
              {activeWallet.primaryEvmAddress !== null && (
                <span className="mt-0.5 block font-mono text-xs text-muted">
                  {shortenAddress(activeWallet.primaryEvmAddress)}
                </span>
              )}
            </span>
            {wallets.length > 1 && (
              <IconChevronDown
                size={16}
                className={`shrink-0 text-muted transition-transform ${
                  pickerOpen ? 'rotate-180' : ''
                }`}
              />
            )}
          </button>

          {pickerOpen && wallets.length > 1 && (
            <div className="animate-rise mt-2 overflow-hidden rounded-xl border border-hairline bg-surface">
              {wallets.map((wallet, index) => (
                <button
                  key={wallet.id}
                  type="button"
                  onClick={() => void pick(wallet.id)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised/60 ${
                    index > 0 ? 'border-t border-hairline' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{wallet.name}</span>
                    {wallet.primaryEvmAddress !== null && (
                      <span className="mt-0.5 block font-mono text-[11px] text-muted">
                        {shortenAddress(wallet.primaryEvmAddress)}
                      </span>
                    )}
                  </span>
                  {wallet.id === activeWalletId && (
                    <IconCheck size={15} className="shrink-0 text-brass" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="w-full">
        <Field
          label={activeWallet !== null ? `Пароль — ${activeWallet.name}` : 'Пароль'}
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Введіть пароль"
        />
        {error !== null && <p className="mt-2 text-left text-xs text-terra">{error}</p>}
      </div>

      <Button type="submit" className="w-full" disabled={busy || password.length === 0}>
        {busy ? 'Розблокування…' : 'Розблокувати'}
      </Button>

      <p className="max-w-[280px] text-xs leading-relaxed text-muted/80">
        Пароль розшифровує сховище локально й нікуди не надсилається. У кожного
        гаманця — власний пароль.
      </p>
    </form>
  );
}
