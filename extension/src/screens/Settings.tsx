/**
 * Екран «Ще»: акаунт, безпека, довідка. Дії поверх наявної логіки стора
 * (lock, навігація) — без нових повідомлень до background.
 */
import {
  IconChevronRight,
  IconLock,
  IconQr,
  IconSend,
  IconShield,
} from '@/src/components/icons';
import { Card, Eyebrow, ScreenHeader } from '@/src/components/ui';
import { shortenAddress } from '@/src/lib/format';
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
