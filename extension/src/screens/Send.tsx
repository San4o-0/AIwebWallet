/**
 * Надсилання коштів (F3.1): мережа, актив (нативний / відомий ERC-20),
 * адреса, сума.
 *
 * Реальний цикл для EVM: GET /v1/tx/params (nonce + EIP-1559 комісії з ноди)
 * → збірка type-2 транзакції (ERC-20: calldata transfer(to, amount)) →
 * keccak256 + secp256k1-підпис у WASM-ядрі → RLP → POST /v1/tx/broadcast →
 * справжній tx hash. Solana/Bitcoin — TODO (потрібна збірка транзакцій цих
 * мереж у ядрі).
 */
import { useMemo, useState } from 'react';

import { IconCheck, IconChevronLeft } from '@/src/components/icons';
import { Button, Field, ScreenHeader, Select } from '@/src/components/ui';
import { broadcastTx, fetchTxParams } from '@/src/lib/api';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import {
  isEvmAddress,
  parseAmountToBaseUnits,
  KNOWN_ERC20,
  type Eip1559TxParams,
  type SignedEvmTx,
} from '@/src/lib/evm';
import { walletCore } from '@/src/lib/wallet-core';
import { useWalletStore } from '@/src/store/wallet';
import { loadWalletCoreWasm } from '@/src/wasm';

/** Значення селектора активу: нативна монета або символ відомого токена. */
const NATIVE_ASSET = '__native__';

export default function Send() {
  const account = useWalletStore((s) => s.account);
  const setScreen = useWalletStore((s) => s.setScreen);
  const [chain, setChain] = useState<Chain>('ethereum');
  const [asset, setAsset] = useState<string>(NATIVE_ASSET);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const tokens = useMemo(() => KNOWN_ERC20[chain] ?? [], [chain]);
  const token = tokens.find((t) => t.symbol === asset) ?? null;
  const symbol = token?.symbol ?? CHAINS[chain].symbol;

  const selectChain = (next: Chain) => {
    setChain(next);
    setAsset(NATIVE_ASSET); // токени різняться між мережами
  };

  const submit = async () => {
    if (account === null) return;
    setError(null);
    setTxHash(null);

    if (CHAINS[chain].kind !== 'evm') {
      setError(
        `Надсилання для ${CHAINS[chain].label} буде доступне пізніше — ` +
          'потрібна збірка транзакцій цієї мережі у ядрі.',
      );
      return;
    }
    const to = recipient.trim();
    if (!isEvmAddress(to)) {
      setError('Вкажіть коректну EVM-адресу отримувача (0x + 40 hex-символів).');
      return;
    }

    setBusy(true);
    try {
      const decimals = token?.decimals ?? 18;
      const baseUnits = parseAmountToBaseUnits(amount, decimals);
      const from = account.addresses.evm;

      // 1. Реальні параметри з ноди: nonce, gas limit, EIP-1559 комісії.
      const params = await fetchTxParams(chain, from, token !== null);

      // 2. Збірка EIP-1559 транзакції (ERC-20: to = контракт, calldata transfer).
      let txParams: Eip1559TxParams;
      const common = {
        chain_id: String(params.chain_id),
        nonce: String(params.nonce),
        max_priority_fee_per_gas: params.fees.standard.max_priority_fee_per_gas,
        max_fee_per_gas: params.fees.standard.max_fee_per_gas,
        gas_limit: params.gas_limit_estimate,
      };
      if (token === null) {
        txParams = { ...common, to, value: baseUnits.toString() };
      } else {
        const wasm = await loadWalletCoreWasm();
        txParams = {
          ...common,
          to: token.address,
          value: '0',
          data: wasm.erc20TransferCalldata(to, baseUnits.toString()),
        };
      }

      // 3. Підпис у background (seed-фраза не покидає service worker).
      const signedJson = await walletCore.signTransaction({
        chain,
        payload: JSON.stringify(txParams),
      });
      const { raw_tx } = JSON.parse(signedJson) as SignedEvmTx;

      // 4. Трансляція через бекенд → справжній tx hash від ноди.
      const { tx_hash } = await broadcastTx({ chain, signed_tx: raw_tx });
      setTxHash(tx_hash);
      setRecipient('');
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося надіслати.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-h-full flex-col gap-5 p-5 pb-24"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <button
        type="button"
        onClick={() => setScreen('home')}
        className="-ml-2 flex w-fit items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <IconChevronLeft size={16} />
        Головна
      </button>

      <ScreenHeader eyebrow="Переказ" title="Надіслати" />

      <Select label="Мережа" value={chain} onChange={(e) => selectChain(e.target.value as Chain)}>
        {CHAIN_IDS.map((id) => (
          <option key={id} value={id}>
            {CHAINS[id].label} ({CHAINS[id].symbol})
          </option>
        ))}
      </Select>

      {tokens.length > 0 && (
        <Select label="Актив" value={asset} onChange={(e) => setAsset(e.target.value)}>
          <option value={NATIVE_ASSET}>{CHAINS[chain].symbol} (нативна монета)</option>
          {tokens.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol} (ERC-20)
            </option>
          ))}
        </Select>
      )}

      <Field
        label="Адреса отримувача"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        placeholder={
          CHAINS[chain].kind === 'evm'
            ? '0x…'
            : CHAINS[chain].kind === 'solana'
              ? 'Base58-адреса'
              : 'bc1…'
        }
        className="font-mono"
        spellCheck={false}
      />

      <Field
        label={`Сума (${symbol})`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.0"
        inputMode="decimal"
      />

      {error !== null && <p className="text-xs leading-relaxed text-terra">{error}</p>}
      {txHash !== null && (
        <div className="animate-rise rounded-[14px] border border-sage/40 bg-sage/10 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-sage">
            <IconCheck size={16} />
            Транзакцію надіслано в мережу
          </p>
          <p className="mt-2 break-all font-mono text-xs leading-relaxed text-muted">{txHash}</p>
        </div>
      )}

      <div className="sticky bottom-14 -mx-5 mt-auto border-t border-hairline bg-bg px-5 pb-3 pt-3">
        <p className="mb-2.5 text-xs leading-relaxed text-muted">
          Комісія: рівень «standard» з EIP-1559-оцінки ноди.
        </p>
        <Button type="submit" className="w-full" disabled={busy || account === null}>
          {busy ? 'Підписання…' : 'Переглянути та надіслати'}
        </Button>
      </div>
    </form>
  );
}
