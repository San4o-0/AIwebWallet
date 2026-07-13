/**
 * Екран «Ще»: гаманці (multi-vault: перемикання, перейменування, додавання,
 * видалення), акаунт, дії, мова інтерфейсу, безпека.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconGlobe,
  IconKey,
  IconLock,
  IconQr,
  IconSend,
  IconShield,
} from '@/src/components/icons';
import { SelectMenu, type SelectOption } from '@/src/components/SelectMenu';
import { Button, Card, Eyebrow, Field, ScreenHeader } from '@/src/components/ui';
import {
  LOCALE_NATIVE_NAMES,
  SUPPORTED_LOCALES,
  getActiveLocale,
  setLocale,
  type Locale,
} from '@/src/i18n';
import { CHAIN_IDS } from '@/src/lib/chains';
import { shortenAddress } from '@/src/lib/format';
import { MAX_WALLETS } from '@/src/lib/vault-storage';
import { walletCore, type WalletSummary } from '@/src/lib/wallet-core';
import { useWalletStore, type Screen } from '@/src/store/wallet';

const APP_VERSION = '0.1.0';

interface Row {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  hint?: string;
  screen?: Screen;
  danger?: boolean;
  action?: () => void;
}

export default function Settings() {
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const lock = useWalletStore((s) => s.lock);
  const setScreen = useWalletStore((s) => s.setScreen);

  const actionRows: Row[] = [
    {
      icon: IconSend,
      label: t('settings.sendAction'),
      hint: t('settings.sendActionHint'),
      screen: 'send',
    },
    {
      icon: IconQr,
      label: t('settings.addressesAction'),
      hint: t('settings.addressesActionHint'),
      screen: 'receive',
    },
    {
      icon: IconGlobe,
      label: t('settings.connectionsAction'),
      hint: t('settings.connectionsActionHint'),
      screen: 'connections',
    },
  ];

  return (
    <div className="screen-in flex flex-col gap-6 p-5 pb-24">
      <ScreenHeader eyebrow={t('settings.eyebrow')} title={t('settings.title')} />

      <WalletsSection />

      {account !== null && (
        <section>
          <Eyebrow className="mb-2.5">{t('settings.account')}</Eyebrow>
          <Card className="p-0">
            <div className="border-b border-hairline px-4 py-3">
              <p className="text-sm font-semibold text-ink">{account.name}</p>
              <p className="mt-0.5 text-xs text-muted">
                {t('settings.accountMeta', { index: account.index })}
              </p>
            </div>
            {(
              [
                ['EVM', account.addresses.evm],
                ['Solana', account.addresses.solana],
                ['Bitcoin', account.addresses.bitcoin],
                ['TRON', account.addresses.tron],
              ] as const
            ).map(([label, address]) => (
              <AddressRow key={label} label={label} address={address} />
            ))}
          </Card>
        </section>
      )}

      <section>
        <Eyebrow className="mb-2.5">{t('settings.actions')}</Eyebrow>
        <Card className="p-0">
          {actionRows.map((row, index) => (
            <button
              key={row.label}
              type="button"
              onClick={() => {
                if (row.screen !== undefined) setScreen(row.screen);
                row.action?.();
              }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-raised/60 ${
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
              <IconChevronRight size={16} className="shrink-0 text-muted rtl:-scale-x-100" />
            </button>
          ))}
        </Card>
      </section>

      <LanguageSection />

      <section>
        <Eyebrow className="mb-2.5">{t('settings.security')}</Eyebrow>
        <Card className="p-0">
          <div className="flex items-start gap-3 border-b border-hairline px-4 py-3">
            <IconShield size={17} className="mt-0.5 shrink-0 text-positive" />
            <p className="text-xs leading-relaxed text-muted">{t('settings.securityNote')}</p>
          </div>
          <SeedRevealRows />
          <button
            type="button"
            onClick={() => void lock()}
            className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-raised/60"
          >
            <IconLock size={17} className="shrink-0 text-danger" />
            <span className="text-sm font-medium text-danger">{t('settings.lock')}</span>
          </button>
        </Card>
      </section>

      <p className="text-center text-xs text-muted/70">
        {t('settings.footer', { version: APP_VERSION, networks: CHAIN_IDS.length })}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Показ seed-фрази (Security): попередження → пароль → фраза.
// Пароль перевіряється в background заново (Argon2id), навіть якщо сесію
// розблоковано. Фраза живе лише в локальному стейті і затирається при
// приховуванні/розмонтуванні. Кнопки копіювання свідомо немає (клавіатурний
// буфер читають інші розширення/застосунки).
// ---------------------------------------------------------------------------

function SeedRevealRows() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hide = () => {
    setPhrase(null);
    setPassword('');
    setError(null);
    setOpen(false);
  };

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      setPhrase(await walletCore.revealSeedPhrase(password));
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.unlockFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-hairline">
      <button
        type="button"
        onClick={() => (open ? hide() : setOpen(true))}
        className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-raised/60"
      >
        <IconKey size={17} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{t('settings.revealSeed')}</span>
          <span className="mt-0.5 block text-xs text-muted">{t('settings.revealSeedHint')}</span>
        </span>
        <IconChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="animate-rise flex flex-col gap-3 px-4 pb-4">
          <div className="rounded-[10px] border border-danger/40 bg-danger/5 p-3">
            <p className="text-xs font-medium leading-relaxed text-danger">
              {t('settings.revealSeedWarning')}
            </p>
          </div>

          {phrase === null ? (
            <>
              <Field
                label={t('common.passwordLabel')}
                type="password"
                value={password}
                autoFocus
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password !== '' && !busy) void reveal();
                }}
                placeholder={t('common.passwordPlaceholder')}
              />
              {error !== null && <p className="text-xs text-danger">{error}</p>}
              <Button disabled={busy || password === ''} onClick={() => void reveal()}>
                {busy ? t('settings.revealSeedChecking') : t('settings.revealSeedShow')}
              </Button>
            </>
          ) : (
            <>
              <ol
                className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-hairline bg-surface px-5 py-4"
                dir="ltr"
              >
                {phrase.split(' ').map((word, i) => (
                  <li key={`${i}-${word}`} className="flex items-baseline gap-2.5">
                    <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted/70">
                      {i + 1}
                    </span>
                    <span className="font-mono text-[13px] text-ink">{word}</span>
                  </li>
                ))}
              </ol>
              <Button variant="secondary" onClick={hide}>
                {t('settings.revealSeedHide')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Секція «Мова» — селектор з усіма локалями реєстру
// ---------------------------------------------------------------------------

function LanguageSection() {
  const { t } = useTranslation();
  // Джерело правди — i18n.language; локальний стейт лише для миттєвого
  // відображення вибору, поки changeLanguage підвантажує JSON локалі.
  const [current, setCurrent] = useState<Locale>(getActiveLocale());

  const onChange = (locale: Locale) => {
    setCurrent(locale);
    // Зберігає вибір у storage.local (пріоритет над мовою браузера) і
    // перемикає i18next; локалі без JSON рендеряться з en-fallback.
    void setLocale(locale);
  };

  const options = useMemo<SelectOption<Locale>[]>(
    () =>
      SUPPORTED_LOCALES.map((locale) => ({
        value: locale,
        label: LOCALE_NATIVE_NAMES[locale],
        secondary: locale.toUpperCase(),
      })),
    [],
  );

  return (
    <section>
      <Eyebrow className="mb-2.5">{t('settings.language')}</Eyebrow>
      <Card>
        <SelectMenu
          label={t('settings.languageLabel')}
          value={current}
          options={options}
          onChange={onChange}
        />
        <p className="mt-2.5 text-xs leading-relaxed text-muted">{t('settings.languageHint')}</p>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Секція «Гаманці» (multi-vault)
// ---------------------------------------------------------------------------

function WalletsSection() {
  const { t } = useTranslation();
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const startAddWallet = useWalletStore((s) => s.startAddWallet);
  /** Id гаманця з розгорнутими діями (одночасно — один). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section>
      <Eyebrow className="mb-2.5">{t('settings.wallets')}</Eyebrow>
      <Card className="stagger-rise p-0">
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
        {wallets.length < MAX_WALLETS ? (
          <button
            type="button"
            onClick={startAddWallet}
            className={`flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-raised/60 ${
              wallets.length > 0 ? 'border-t border-hairline' : ''
            }`}
          >
            <span className="flex size-[17px] shrink-0 items-center justify-center text-accent" aria-hidden>
              +
            </span>
            <span className="text-sm font-medium text-accent">{t('settings.addWallet')}</span>
          </button>
        ) : (
          <p className="border-t border-hairline px-4 py-3 text-xs leading-relaxed text-muted">
            {t('errors.walletLimit', { max: MAX_WALLETS })}
          </p>
        )}
      </Card>
      {error !== null && <p className="mt-2 text-xs text-danger">{error}</p>}
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
  const { t } = useTranslation();
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
        className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-raised/60"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{wallet.name}</span>
            {active && (
              <span className="eyebrow shrink-0 rounded-full border border-accent/40 px-1.5 py-px text-[9px] text-accent">
                {t('settings.walletActive')}
              </span>
            )}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-muted" dir="ltr">
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
                  label={t('settings.walletName')}
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary" className="shrink-0" disabled={busy}>
                {t('common.save')}
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!active && (
                <Button variant="secondary" disabled={busy} onClick={() => void doSwitch()}>
                  {t('settings.switch')}
                </Button>
              )}
              {/* Перейменувати — бурштиновий заповнений (акцент палітри) */}
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setName(wallet.name);
                  setRenaming(true);
                }}
              >
                {t('settings.rename')}
              </Button>
              {/* Видалити — деструктивна, заповнений danger-фон */}
              {!confirmingRemove && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(true)}
                >
                  {t('settings.remove')}
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
  const { t } = useTranslation();
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
    <div className="animate-rise rounded-xl border border-danger/40 bg-danger/5 p-3">
      <p className="text-xs font-medium leading-relaxed text-danger">
        {t('settings.removeWarning')}
        {isOnly ? ` ${t('settings.removeWarningLast')}` : ''}
      </p>
      <label className="mt-2.5 flex items-start gap-2.5 text-xs leading-snug text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        {t('settings.savedSeedConfirm')}
      </label>
      <div className="mt-3 flex gap-2">
        <Button variant="danger" disabled={!confirmed || busy} onClick={() => void doRemove()}>
          {busy ? t('settings.removing') : t('settings.removeNamed', { name: wallet.name })}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Рядок адреси акаунта: підпис, скорочена адреса і кнопка копіювання з фідбеком. */
function AddressRow({ label, address }: { label: string; address: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const empty = address === '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      /* clipboard недоступний — тихо ігноруємо, адресу видно й вручну */
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-ink" dir="ltr">
          {empty ? '—' : shortenAddress(address, 6)}
        </span>
        {!empty && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? t('receive.copied') : t('receive.copyAddress')}
            title={copied ? t('receive.copied') : t('receive.copyAddress')}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink active:scale-95"
          >
            {copied ? (
              <IconCheck size={14} className="text-positive" />
            ) : (
              <IconCopy size={14} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
