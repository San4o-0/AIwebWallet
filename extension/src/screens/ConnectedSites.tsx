/**
 * Екран «Підключені сайти» (Settings → Ще): модель дозволів по origin.
 *
 * Показує сайти, яким користувач явно дозволив бачити адресу гаманця (Approve
 * на eth_requestAccounts), з датою підключення і ревокацією — по одному або
 * всіх одразу. Непідключений сайт отримує від `eth_accounts` порожній масив,
 * тож ревокація тут реально «засліплює» dApp до наступного підключення.
 *
 * Джерело правди — background (src/lib/connections.ts, chrome.storage.local);
 * екран лише читає список і шле ревокації.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconChevronLeft, IconGlobe, IconShield, IconUnlink } from '@/src/components/icons';
import { Button, Card, EmptyState, ErrorNote, Eyebrow, ScreenHeader, Spinner } from '@/src/components/ui';
import { localizeUnknownError } from '@/src/i18n';
import { walletCore, type ConnectedSite } from '@/src/lib/wallet-core';
import { useWalletStore } from '@/src/store/wallet';

/** Дата підключення мовою UI (без часу — достатньо дня). */
function formatConnectedAt(timestamp: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

/** `https://app.uniswap.org` → `app.uniswap.org` (схема — окремим бейджем). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Не-https origin — сигнал ризику: підпис/адреса по cleartext-каналу. */
function isInsecureOrigin(origin: string): boolean {
  return origin.startsWith('http://');
}

export default function ConnectedSites() {
  const { t, i18n } = useTranslation();
  const setScreen = useWalletStore((s) => s.setScreen);

  const [sites, setSites] = useState<ConnectedSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyOrigin, setBusyOrigin] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const load = async () => {
    setError(null);
    try {
      setSites(await walletCore.listConnectedSites());
    } catch (e) {
      setSites([]);
      setError(localizeUnknownError(e, 'errors.connectionsLoadFailed'));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const disconnect = async (origin: string) => {
    setBusyOrigin(origin);
    setError(null);
    try {
      setSites(await walletCore.disconnectSite(origin));
    } catch (e) {
      setError(localizeUnknownError(e, 'errors.disconnectFailed'));
    } finally {
      setBusyOrigin(null);
    }
  };

  const disconnectAll = async () => {
    setBusyOrigin('*');
    setError(null);
    try {
      setSites(await walletCore.disconnectAllSites());
      setConfirmingAll(false);
    } catch (e) {
      setError(localizeUnknownError(e, 'errors.disconnectFailed'));
    } finally {
      setBusyOrigin(null);
    }
  };

  return (
    <div className="screen-in flex min-h-full flex-col gap-5 p-5 pb-24">
      <button
        type="button"
        onClick={() => setScreen('settings')}
        className="-ms-2 flex w-fit items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <IconChevronLeft size={16} className="rtl:-scale-x-100" />
        {t('settings.title')}
      </button>

      <ScreenHeader eyebrow={t('connections.eyebrow')} title={t('connections.title')} />

      <Card className="flex items-start gap-3">
        <IconShield size={17} className="mt-0.5 shrink-0 text-positive" />
        <p className="text-xs leading-relaxed text-muted">{t('connections.note')}</p>
      </Card>

      {error !== null && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}

      {sites === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : sites.length === 0 ? (
        <EmptyState
          icon={<IconGlobe size={22} />}
          title={t('connections.emptyTitle')}
          hint={t('connections.emptyHint')}
        />
      ) : (
        <>
          <section>
            <Eyebrow className="mb-2.5">
              {t('connections.listEyebrow', { count: sites.length })}
            </Eyebrow>
            <Card className="stagger-rise p-0">
              {sites.map((site, index) => (
                <SiteRow
                  key={site.origin}
                  site={site}
                  first={index === 0}
                  locale={i18n.language}
                  busy={busyOrigin !== null}
                  onDisconnect={() => void disconnect(site.origin)}
                />
              ))}
            </Card>
          </section>

          {/* «Відключити всі» — деструктивна дія, тож із підтвердженням. */}
          {confirmingAll ? (
            <div className="animate-rise rounded-[10px] border border-danger/40 bg-danger/5 p-3.5">
              <p className="text-xs font-medium leading-relaxed text-danger">
                {t('connections.disconnectAllWarning', { count: sites.length })}
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="danger"
                  disabled={busyOrigin !== null}
                  onClick={() => void disconnectAll()}
                >
                  {busyOrigin === '*'
                    ? t('connections.disconnecting')
                    : t('connections.disconnectAllConfirm')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busyOrigin !== null}
                  onClick={() => setConfirmingAll(false)}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busyOrigin !== null}
              onClick={() => setConfirmingAll(true)}
            >
              {t('connections.disconnectAll')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** Рядок сайту: origin + дата підключення + кнопка ревокації. */
function SiteRow({
  site,
  first,
  locale,
  busy,
  onDisconnect,
}: {
  site: ConnectedSite;
  first: boolean;
  locale: string;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const insecure = isInsecureOrigin(site.origin);

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 ${first ? '' : 'border-t border-hairline'}`}
    >
      <IconGlobe size={17} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className="truncate font-mono text-[13px] text-ink" dir="ltr">
            {hostOf(site.origin)}
          </span>
          {insecure && (
            <span className="eyebrow shrink-0 rounded-full border border-danger/40 px-1.5 py-px text-[9px] text-danger">
              {t('connections.insecure')}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t('connections.connectedAt', {
            date: formatConnectedAt(site.connectedAt, locale),
          })}
        </p>
      </div>
      <button
        type="button"
        onClick={onDisconnect}
        disabled={busy}
        aria-label={t('connections.disconnectNamed', { origin: hostOf(site.origin) })}
        title={t('connections.disconnect')}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <IconUnlink size={15} />
      </button>
    </div>
  );
}
