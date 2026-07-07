/**
 * Екран «Отримати»: адреси акаунта по мережах, QR-код (генерується локально
 * пакетом qrcode — CSP-safe, без зовнішніх API), копіювання адреси та
 * способи поповнення, включно з on-ramp провайдерами (зовнішні сервіси,
 * відкриваються через browser.tabs.create).
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { browser } from 'wxt/browser';

import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconExternal,
} from '@/src/components/icons';
import { Card, Eyebrow, EmptyState, ScreenHeader } from '@/src/components/ui';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { useWalletStore } from '@/src/store/wallet';

const EVM_CHAIN_LABELS = CHAIN_IDS.filter((id) => CHAINS[id].kind === 'evm')
  .map((id) => CHAINS[id].label)
  .join(', ');

/** Адреса акаунта для конкретної мережі (EVM-адреса спільна). */
function addressFor(
  chain: Chain,
  addresses: { evm: string; solana: string; bitcoin: string },
): string {
  switch (CHAINS[chain].kind) {
    case 'evm':
      return addresses.evm;
    case 'solana':
      return addresses.solana;
    case 'bitcoin':
      return addresses.bitcoin;
  }
}

/** Розбивка адреси на групи по 4 символи для читабельності. */
function chunkAddress(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [address];
}

// --- On-ramp провайдери (зовнішні сервіси) ---

interface OnRampProvider {
  name: string;
  /** Формує URL з підставленою адресою, якщо провайдер це підтримує. */
  url: (chain: Chain, address: string) => string;
}

const MOONPAY_CODE: Record<Chain, string> = {
  ethereum: 'eth',
  polygon: 'pol',
  bsc: 'bnb',
  arbitrum: 'eth_arbitrum',
  base: 'eth_base',
  solana: 'sol',
  bitcoin: 'btc',
};

const RAMP_ASSET: Record<Chain, string> = {
  ethereum: 'ETH_ETH',
  polygon: 'MATIC_POL',
  bsc: 'BSC_BNB',
  arbitrum: 'ARBITRUM_ETH',
  base: 'BASE_ETH',
  solana: 'SOLANA_SOL',
  bitcoin: 'BTC_BTC',
};

const TRANSAK_NETWORK: Record<Chain, string> = {
  ethereum: 'ethereum',
  polygon: 'polygon',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  base: 'base',
  solana: 'solana',
  bitcoin: 'mainnet',
};

const ONRAMP_PROVIDERS: OnRampProvider[] = [
  {
    name: 'MoonPay',
    url: (chain, address) =>
      `https://buy.moonpay.com/?defaultCurrencyCode=${MOONPAY_CODE[chain]}&walletAddress=${encodeURIComponent(address)}`,
  },
  {
    name: 'Ramp Network',
    url: (chain, address) =>
      `https://app.ramp.network/?defaultAsset=${RAMP_ASSET[chain]}&userAddress=${encodeURIComponent(address)}`,
  },
  {
    name: 'Transak',
    url: (chain, address) =>
      `https://global.transak.com/?defaultCryptoCurrency=${CHAINS[chain].symbol}&network=${TRANSAK_NETWORK[chain]}&walletAddress=${encodeURIComponent(address)}`,
  },
];

export default function Receive() {
  const account = useWalletStore((s) => s.account);
  const [chain, setChain] = useState<Chain | null>(null);

  if (account === null) {
    return (
      <div className="p-5 pb-24">
        <ScreenHeader eyebrow="Поповнення" title="Отримати" />
        <div className="mt-6">
          <EmptyState
            title="Акаунт недоступний"
            hint="Розблокуйте гаманець, щоб побачити адреси для отримання."
          />
        </div>
      </div>
    );
  }

  if (chain === null) {
    return <ChainList onSelect={setChain} addresses={account.addresses} />;
  }

  return (
    <ChainDetail
      chain={chain}
      address={addressFor(chain, account.addresses)}
      onBack={() => setChain(null)}
    />
  );
}

function ChainList({
  onSelect,
  addresses,
}: {
  onSelect: (chain: Chain) => void;
  addresses: { evm: string; solana: string; bitcoin: string };
}) {
  return (
    <div className="flex flex-col gap-6 p-5 pb-24">
      <ScreenHeader eyebrow="Поповнення" title="Отримати">
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Оберіть мережу, щоб побачити адресу та QR-код для поповнення.
        </p>
      </ScreenHeader>

      <section>
        <Eyebrow className="mb-2.5">Мережі</Eyebrow>
        <Card className="p-0">
          {CHAIN_IDS.map((id, index) => {
            const hasAddress = addressFor(id, addresses) !== '';
            return (
              <button
                key={id}
                type="button"
                disabled={!hasAddress}
                onClick={() => onSelect(id)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-40 ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span
                    className="inline-block size-1.5 rounded-full opacity-80"
                    style={{ backgroundColor: CHAINS[id].color }}
                  />
                  <span className="text-sm text-ink">{CHAINS[id].label}</span>
                  <span className="text-xs text-muted">{CHAINS[id].symbol}</span>
                </span>
                <IconChevronRight size={16} className="text-muted" />
              </button>
            );
          })}
        </Card>
        <p className="mt-2.5 text-xs leading-relaxed text-muted">
          Адреса для EVM-мереж ({EVM_CHAIN_LABELS}) спільна.
        </p>
      </section>
    </div>
  );
}

function ChainDetail({
  chain,
  address,
  onBack,
}: {
  chain: Chain;
  address: string;
  onBack: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEvm = CHAINS[chain].kind === 'evm';

  // QR генерується локально в canvas (CSP-safe, без зовнішніх API).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || address === '') return;
    QRCode.toCanvas(canvas, address, {
      width: 168,
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#121014', light: '#f2efe6' },
    }).catch((error: unknown) => {
      console.error('[aiwallet] Не вдалося згенерувати QR-код:', error);
    });
  }, [address]);

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setCopyError(false);
    }, 2000);
  };

  const openProvider = (provider: OnRampProvider) => {
    void browser.tabs.create({ url: provider.url(chain, address) });
  };

  return (
    <div className="flex flex-col gap-6 p-5 pb-24">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <IconChevronLeft size={16} />
          Мережі
        </button>
      </header>

      <section className="animate-rise">
        <ScreenHeader
          eyebrow="Адреса для отримання"
          title={`${CHAINS[chain].label} · ${CHAINS[chain].symbol}`}
        />

        {/* Адреса як «візитівка»: QR на слоновій кістці в hairline-рамці */}
        <Card className="mt-4 flex flex-col items-center gap-4 p-5">
          <div className="rounded-lg border border-brass/40 bg-ink p-3">
            <canvas ref={canvasRef} className="block size-[168px]" aria-label="QR-код адреси" />
          </div>

          <p className="break-all text-center font-mono text-[13px] leading-relaxed text-ink">
            {chunkAddress(address).map((part, index) => (
              <span key={index} className={index % 2 === 1 ? 'text-muted' : undefined}>
                {part}
              </span>
            ))}
          </p>

          <button
            type="button"
            onClick={() => void copy()}
            className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
              copied
                ? 'bg-sage/15 text-sage'
                : 'bg-brass text-bg hover:bg-brass-bright'
            }`}
          >
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            {copied ? 'Скопійовано' : 'Скопіювати адресу'}
          </button>
          {copyError && (
            <p className="text-xs text-terra">
              Буфер обміну недоступний — виділіть і скопіюйте адресу вручну.
            </p>
          )}
        </Card>

        {/* Попередження про мережу */}
        <div className="mt-3 rounded-[14px] border border-amber/40 bg-amber/10 p-3.5">
          <p className="text-xs leading-relaxed text-ink">
            Надсилайте тільки активи мережі {CHAINS[chain].label} на цю адресу.
            Активи з інших мереж буде втрачено.
          </p>
          {isEvm && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Адреса спільна для всіх EVM-мереж: {EVM_CHAIN_LABELS}.
            </p>
          )}
        </div>
      </section>

      <section>
        <Eyebrow className="mb-2.5">Способи поповнення</Eyebrow>
        <Card className="p-0">
          <div className="px-4 py-3.5">
            <p className="text-sm font-medium text-ink">З іншого гаманця</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Надішліть кошти на адресу вище або відскануйте QR-код у гаманці-відправнику.
            </p>
          </div>
          <div className="border-t border-hairline px-4 py-3.5">
            <p className="text-sm font-medium text-ink">З біржі</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Виведіть кошти з біржі на цю адресу. У формі виводу оберіть саме мережу{' '}
              {CHAINS[chain].label} — інакше кошти не дійдуть.
            </p>
          </div>
          <div className="border-t border-hairline px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink">Купити картою</p>
              <span className="eyebrow">Зовнішній сервіс</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Провайдер відкриється в новій вкладці; ваша адреса буде підставлена автоматично.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {ONRAMP_PROVIDERS.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  onClick={() => openProvider(provider)}
                  className="flex items-center justify-between rounded-xl border border-hairline bg-raised px-3.5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-brass/50"
                >
                  {provider.name}
                  <IconExternal size={15} className="text-muted" />
                </button>
              ))}
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
