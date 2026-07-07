/** Екран розблокування паролем (F1.5). */
import { useState } from 'react';

import { BrandMark } from '@/src/components/icons';
import { Button, Eyebrow, Field } from '@/src/components/ui';
import { useWalletStore } from '@/src/store/wallet';

export default function Unlock() {
  const unlock = useWalletStore((s) => s.unlock);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await unlock(password);
    if (result !== null) {
      setError(result);
      setBusy(false);
    }
  };

  return (
    <form
      className="flex h-full flex-col items-center justify-center gap-7 overflow-y-auto p-6 text-center"
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

      <div className="w-full">
        <Field
          label="Пароль"
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
        Пароль розшифровує сховище локально й нікуди не надсилається.
      </p>
    </form>
  );
}
