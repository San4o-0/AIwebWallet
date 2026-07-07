/**
 * Екран «Ще»: гаманці (multi-vault: перемикання, перейменування, додавання,
 * видалення), акаунт, безпека, довідка.
 */
import { useState } from 'react';

import {
  IconChevronDown,
  IconChevronRight,
  IconLock,
  IconQr,
  IconSend,
  IconShield,
} from '@/src/components/icons';
import { Button, Card, Eyebrow, Field, ScreenHeader } from '@/src/components/ui';
import { shortenAddress } from '@/src/lib/format';
import type { WalletSummary } from '@/src/lib/wallet-core';
import { useWalletStore, type Screen } from '@/src/store/wallet';

interface Row {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  hint?: string;
  screen?: Screen;
  danger?: boolean;
  action?: () => void;
}

export default function Settings() {
  const account = useWalletStore((s) => s.account);
  const lock = useWalletStore((s) => s.lock);
  const setScreen = useWalletStore((s) => s.setScreen);

  const actionRows: Row[] = [
    {
      icon: IconSend,
      label: 'Надіслати кошти',
      hint: 'Переказ у мережах EVM',
      screen: 'send',
    },
    {
      icon: IconQr,
      label: 'Адреси та QR-коди',
      hint: 'Отримання і поповнення',
      screen: 'receive',
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-5 pb-24">
      <ScreenHeader eyebrow="Налаштування" title="Ще" />

      <WalletsSection />

      {account !== null && (
        <section>
          <Eyebrow className="mb-2.5">Акаунт</Eyebrow>
          <Card className="p-0">
            <div className="border-b border-hairline px-4 py-3">
              <p className="text-sm font-semibold text-ink">{account.name}</p>
              <p className="mt-0.5 text-xs text-muted">Створений із seed-фрази · індекс {account.index}</p>
            </div>
            {(
              [
                ['EVM', account.addresses.evm],
                ['Solana', account.addresses.solana],
                ['Bitcoin', account.addresses.bitcoin],
              ] as const
            ).map(([label, address]) => (
              <div
                key={label}
                className="flex items-center justify-between border-b border-hairline px-4 py-2.5 last:border-b-0"
              >
                <span className="text-xs text-muted">{label}</span>
                <span className="font-mono text-xs text-ink">
                  {address !== '' ? shortenAddress(address, 6) : '—'}
                </span>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section>
        <Eyebrow className="mb-2.5">Дії</Eyebrow>
        <Card className="p-0">
          {actionRows.map((row, index) => (
            <button
              key={row.label}
              type="button"
              onClick={() => {
                if (row.screen !== undefined) setScreen(row.screen);
                row.action?.();
              }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60 ${
                index > 0 ? 'border-t border-hairline' : ''
              }`}
            >
              <row.icon size={17} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{row.label}</span>
                {row.hint !== undefined && (
                  <span className="mt-0.5 block text-xs text-muted">{row.hint}</span>
                )}
              </span>
              <IconChevronRight size={16} className="shrink-0 text-muted" />
            </button>
          ))}
        </Card>
      </section>

      <section>
        <Eyebrow className="mb-2.5">Безпека</Eyebrow>
        <Card className="p-0">
          <div className="flex items-start gap-3 border-b border-hairline px-4 py-3">
            <IconShield size={17} className="mt-0.5 shrink-0 text-sage" />
            <p className="text-xs leading-relaxed text-muted">
              Сховище зашифровано локально (Argon2id + AES-256-GCM). Seed-фраза не
              покидає пристрій; AI-чат не має доступу до підпису транзакцій.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void lock()}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60"
          >
            <IconLock size={17} className="shrink-0 text-terra" />
            <span className="text-sm font-medium text-terra">Заблокувати гаманець</span>
          </button>
        </Card>
      </section>

      <p className="text-center text-xs text-muted/70">
        AI Wallet 0.1.0 · 7 мереж · non-custodial
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Секція «Гаманці» (multi-vault)
// ---------------------------------------------------------------------------

function WalletsSection() {
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const startAddWallet = useWalletStore((s) => s.startAddWallet);
  /** Id гаманця з розгорнутими діями (одночасно — один). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section>
      <Eyebrow className="mb-2.5">Гаманці</Eyebrow>
      <Card className="p-0">
        {wallets.map((wallet, index) => (
          <WalletRow
            key={wallet.id}
            wallet={wallet}
            active={wallet.id === activeWalletId}
            isOnly={wallets.length === 1}
            first={index === 0}
            expanded={expandedId === wallet.id}
            onToggle={() => {
              setError(null);
              setExpandedId((current) => (current === wallet.id ? null : wallet.id));
            }}
            onError={setError}
          />
        ))}
        <button
          type="button"
          onClick={startAddWallet}
          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60 ${
            wallets.length > 0 ? 'border-t border-hairline' : ''
          }`}
        >
          <span className="flex size-[17px] shrink-0 items-center justify-center text-brass" aria-hidden>
            +
          </span>
          <span className="text-sm font-medium text-brass">Додати гаманець</span>
        </button>
      </Card>
      {error !== null && <p className="mt-2 text-xs text-terra">{error}</p>}
    </section>
  );
}

function WalletRow({
  wallet,
  active,
  isOnly,
  first,
  expanded,
  onToggle,
  onError,
}: {
  wallet: WalletSummary;
  active: boolean;
  isOnly: boolean;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  onError: (message: string | null) => void;
}) {
  const switchWallet = useWalletStore((s) => s.switchWallet);
  const renameWallet = useWalletStore((s) => s.renameWallet);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(wallet.name);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const doSwitch = async () => {
    setBusy(true);
    onError(await switchWallet(wallet.id));
    setBusy(false);
  };

  const doRename = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === wallet.name) {
      setRenaming(false);
      setName(wallet.name);
      return;
    }
    setBusy(true);
    const error = await renameWallet(wallet.id, trimmed);
    onError(error);
    if (error === null) setRenaming(false);
    setBusy(false);
  };

  return (
    <div className={first ? '' : 'border-t border-hairline'}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{wallet.name}</span>
            {active && (
              <span className="eyebrow shrink-0 rounded-full border border-brass/40 px-1.5 py-px text-[9px] text-brass">
                Активний
              </span>
            )}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-muted">
            {wallet.primaryEvmAddress !== null ? shortenAddress(wallet.primaryEvmAddress, 6) : '—'}
          </span>
        </span>
        <IconChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="animate-rise flex flex-col gap-3 border-t border-hairline bg-surface/60 px-4 py-3">
          {renaming ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void doRename();
              }}
            >
              <div className="flex-1">
                <Field
                  label="Назва гаманця"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary" className="shrink-0" disabled={busy}>
                Зберегти
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!active && (
                <Button variant="secondary" disabled={busy} onClick={() => void doSwitch()}>
                  Перемкнути
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setName(wallet.name);
                  setRenaming(true);
                }}
              >
                Перейменувати
              </Button>
              {!confirmingRemove && (
                <Button
                  variant="ghost"
                  className="text-terra hover:text-terra"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(true)}
                >
                  Видалити
                </Button>
              )}
            </div>
          )}

          {confirmingRemove && !renaming && (
            <RemoveConfirm
              wallet={wallet}
              isOnly={isOnly}
              onCancel={() => setConfirmingRemove(false)}
              onError={onError}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Двоетапне підтвердження видалення: попередження теракотою + чекбокс
 * «Я зберіг seed-фразу» — кнопка активується лише після нього.
 */
function RemoveConfirm({
  wallet,
  isOnly,
  onCancel,
  onError,
}: {
  wallet: WalletSummary;
  isOnly: boolean;
  onCancel: () => void;
  onError: (message: string | null) => void;
}) {
  const removeWallet = useWalletStore((s) => s.removeWallet);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const doRemove = async () => {
    setBusy(true);
    const error = await removeWallet(wallet.id);
    onError(error);
    if (error !== null) setBusy(false);
  };

  return (
    <div className="animate-rise rounded-xl border border-terra/40 bg-terra/5 p-3">
      <p className="text-xs font-medium leading-relaxed text-terra">
        Без seed-фрази цей гаманець не відновити. Шифротекст буде видалено з
        цього пристрою назавжди.
        {isOnly ? ' Це останній гаманець — далі знадобиться онбординг.' : ''}
      </p>
      <label className="mt-2.5 flex items-start gap-2.5 text-xs leading-snug text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-brass"
        />
        Я зберіг seed-фразу цього гаманця
      </label>
      <div className="mt-3 flex gap-2">
        <Button variant="danger" disabled={!confirmed || busy} onClick={() => void doRemove()}>
          {busy ? 'Видалення…' : `Видалити «${wallet.name}»`}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Скасувати
        </Button>
      </div>
    </div>
  );
}
