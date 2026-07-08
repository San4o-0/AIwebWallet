/**
 * Екран «Отримати»: адреси акаунта по мережах, QR-код (генерується локально
 * пакетом qrcode — CSP-safe, без зовнішніх API), копіювання адреси та
 * способи поповнення, включно з on-ramp провайдерами (зовнішні сервіси,
 * відкриваються через browser.tabs.create).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { browser } from 'wxt/browser';

import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconExternal,
} from '@/src/components/icons';
import { ChainIcon } from '@/src/components/chain-icons';
import { Card, Eyebrow, EmptyState, ScreenHeader } from '@/src/components/ui';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { useWalletStore } from '@/src/store/wallet';

const EVM_CHAIN_LABELS = CHAIN_IDS.filter((id) => CHAINS[id].kind === 'evm')
  .map((id) => CHAINS[id].label)
  .join(', ');

/** Адреса акаунта для конкретної мережі (EVM-адреса спільна). */
function addressFor(
  chain: Chain,
  addresses: { evm: string; solana: string; bitcoin: string; tron: string },
): string {
  switch (CHAINS[chain].kind) {
    case 'evm':
      return addresses.evm;
    case 'solana':
      return addresses.solana;
    case 'bitcoin':
      return addresses.bitcoin;
    case 'tron':
      return addresses.tron;
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
  tron: 'trx',
};

const RAMP_ASSET: Record<Chain, string> = {
  ethereum: 'ETH_ETH',
  polygon: 'MATIC_POL',
  bsc: 'BSC_BNB',
  arbitrum: 'ARBITRUM_ETH',
  base: 'BASE_ETH',
  solana: 'SOLANA_SOL',
  bitcoin: 'BTC_BTC',
  tron: 'TRON_TRX',
};

const TRANSAK_NETWORK: Record<Chain, string> = {
  ethereum: 'ethereum',
  polygon: 'polygon',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  base: 'base',
  solana: 'solana',
  bitcoin: 'mainnet',
  tron: 'tron',
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
  const { t } = useTranslation();
  const account = useWalletStore((s) => s.account);
  const [chain, setChain] = useState<Chain | null>(null);

  if (account === null) {
    return (
      <div className="p-5 pb-24">
        <ScreenHeader eyebrow={t('receive.eyebrow')} title={t('receive.title')} />
        <div className="mt-6">
          <EmptyState title={t('receive.noAccountTitle')} hint={t('receive.noAccountHint')} />
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
  addresses: { evm: string; solana: string; bitcoin: string; tron: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6 p-5 pb-24">
      <ScreenHeader eyebrow={t('receive.eyebrow')} title={t('receive.title')}>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t('receive.chooseNetwork')}</p>
      </ScreenHeader>

      <section>
        <Eyebrow className="mb-2.5">{t('common.networks')}</Eyebrow>
        <Card className="p-0">
          {CHAIN_IDS.map((id, index) => {
            const hasAddress = addressFor(id, addresses) !== '';
            return (
              <button
                key={id}
                type="button"
                disabled={!hasAddress}
                onClick={() => onSelect(id)}
                className={`flex w-full items-center justify-between px-4 py-3 text-start transition-colors hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-40 ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <ChainIcon chain={id} size={20} className="shrink-0" />
                  <span className="text-sm text-ink">{CHAINS[id].label}</span>
                  <span className="text-xs text-muted">{CHAINS[id].symbol}</span>
                </span>
                <IconChevronRight size={16} className="text-muted rtl:-scale-x-100" />
              </button>
            );
          })}
        </Card>
        <p className="mt-2.5 text-xs leading-relaxed text-muted">
          {t('receive.evmShared', { chains: EVM_CHAIN_LABELS })}
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
  const { t } = useTranslation();
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
      console.error('[aiwallet] QR code generation failed:', error);
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
          className="-ms-2 flex items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <IconChevronLeft size={16} className="rtl:-scale-x-100" />
          {t('common.networks')}
        </button>
      </header>

      <section className="animate-rise">
        <ScreenHeader
          eyebrow={t('receive.addressEyebrow')}
          title={`${CHAINS[chain].label} · ${CHAINS[chain].symbol}`}
        />

        {/* Адреса як «візитівка»: QR на слоновій кістці в hairline-рамці */}
        <Card className="mt-4 flex flex-col items-center gap-4 p-5">
          <div className="rounded-lg border border-accent/40 bg-ink p-3">
            <canvas ref={canvasRef} className="block size-[168px]" aria-label={t('receive.qrAria')} />
          </div>

          <p className="break-all text-center font-mono text-[13px] leading-relaxed text-ink" dir="ltr">
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
                ? 'bg-positive/15 text-positive'
                : 'bg-accent text-bg hover:bg-accent-bright'
            }`}
          >
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            {copied ? t('receive.copied') : t('receive.copyAddress')}
          </button>
          {copyError && (
            <p className="text-xs text-danger">{t('receive.clipboardError')}</p>
          )}
        </Card>

        {/* Попередження про мережу */}
        <div className="mt-3 rounded-[10px] border border-amber/40 bg-amber/10 p-3.5">
          <p className="text-xs leading-relaxed text-ink">
            {t('receive.networkWarning', { chain: CHAINS[chain].label })}
          </p>
          {isEvm && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              {t('receive.evmSharedDetail', { chains: EVM_CHAIN_LABELS })}
            </p>
          )}
        </div>
      </section>

      <section>
        <Eyebrow className="mb-2.5">{t('receive.topUpMethods')}</Eyebrow>
        <Card className="p-0">
          <div className="px-4 py-3.5">
            <p className="text-sm font-medium text-ink">{t('receive.fromWallet')}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('receive.fromWalletHint')}</p>
          </div>
          <div className="border-t border-hairline px-4 py-3.5">
            <p className="text-sm font-medium text-ink">{t('receive.fromExchange')}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {t('receive.fromExchangeHint', { chain: CHAINS[chain].label })}
            </p>
          </div>
          <div className="border-t border-hairline px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink">{t('receive.buyWithCard')}</p>
              <span className="eyebrow">{t('receive.externalService')}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('receive.providerHint')}</p>
            <div className="mt-3 flex flex-col gap-2">
              {ONRAMP_PROVIDERS.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  onClick={() => openProvider(provider)}
                  className="flex items-center justify-between rounded-xl border border-hairline bg-raised px-3.5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent/50"
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
