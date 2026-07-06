/**
 * Надсилання коштів (F3.1): мережа, адреса, сума.
 * Підпис — мок WalletCore; трансляція — POST /v1/tx/broadcast (fallback мок).
 */
import { useState } from 'react';

import { Button, Card, Field, ScreenTitle } from '@/src/components/ui';
import { broadcastTx } from '@/src/lib/api';
import { CHAINS, CHAIN_IDS, type Chain } from '@/src/lib/chains';
import { walletCore } from '@/src/lib/wallet-core';
import { useWalletStore } from '@/src/store/wallet';

export default function Send() {
  const account = useWalletStore((s) => s.account);
  const [chain, setChain] = useState<Chain>('ethereum');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const submit = async () => {
    if (account === null) return;
    setError(null);
    setTxHash(null);
    if (recipient.trim().length === 0) {
      setError('Вкажіть адресу отримувача.');
      return;
    }
    const parsed = Number.parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Вкажіть коректну суму.');
      return;
    }
    setBusy(true);
    try {
      // Мок-потік: реальний варіант — decode → simulate → risk → підпис у WASM.
      const signedTx = await walletCore.signTransaction({
        chain,
        payload: JSON.stringify({ to: recipient.trim(), amount }),
      });
      const { txHash: hash } = await broadcastTx({ chain, signedTx });
      setTxHash(hash);
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
      className="flex flex-1 flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ScreenTitle>Надіслати</ScreenTitle>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">Мережа</span>
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value as Chain)}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-100 outline-none focus:border-emerald-500/70"
        >
          {CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              {CHAINS[id].label} ({CHAINS[id].symbol})
            </option>
          ))}
        </select>
      </label>

      <Field
        label="Адреса отримувача"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        placeholder={CHAINS[chain].kind === 'evm' ? '0x…' : CHAINS[chain].kind === 'solana' ? 'Base58-адреса' : 'bc1…'}
        className="font-mono"
        spellCheck={false}
      />

      <Field
        label={`Сума (${CHAINS[chain].symbol})`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.0"
        inputMode="decimal"
      />

      {error !== null && <p className="text-xs text-red-400">{error}</p>}
      {txHash !== null && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <p className="text-sm text-emerald-300">Транзакцію надіслано (мок)</p>
          <p className="mt-1 break-all font-mono text-xs text-zinc-400">{txHash}</p>
        </Card>
      )}

      <div className="mt-auto">
        <p className="mb-2 text-xs text-zinc-600">
          Комісія: оцінка газу (EIP-1559 / sat/vB / CU price) з'явиться разом із бекендом.
        </p>
        <Button type="submit" className="w-full" disabled={busy || account === null}>
          {busy ? 'Підписання…' : 'Переглянути та надіслати'}
        </Button>
      </div>
    </form>
  );
}
