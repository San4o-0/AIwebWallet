/** Екран розблокування паролем (F1.5). */
import { useState } from 'react';

import { Button, Field, ScreenTitle } from '@/src/components/ui';
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
      className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-4xl">◆</div>
      <ScreenTitle>З поверненням</ScreenTitle>
      <div className="w-full">
        <Field
          label="Пароль"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Введіть пароль"
        />
        {error !== null && <p className="mt-2 text-left text-xs text-red-400">{error}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy || password.length === 0}>
        {busy ? 'Розблокування…' : 'Розблокувати'}
      </Button>
      <p className="text-xs text-zinc-600">
        Пароль розшифровує сховище локально й нікуди не надсилається.
      </p>
    </form>
  );
}
