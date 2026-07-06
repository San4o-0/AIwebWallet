/**
 * Онбординг: створення нового гаманця або імпорт (F1.1, F1.2).
 * Крипто-операції виконує WASM-ядро (crates/wallet-core): реальна генерація
 * BIP-39 фрази у popup, створення зашифрованого vault (Argon2id + AES-GCM) —
 * у background; у chrome.storage.local потрапляє лише шифротекст.
 */
import { useState } from 'react';

import { Button, Card, Field, ScreenTitle } from '@/src/components/ui';
import { walletCore } from '@/src/lib/wallet-core';
import { useWalletStore } from '@/src/store/wallet';

type Mode = 'choice' | 'create' | 'import';

export default function Onboarding() {
  const [mode, setMode] = useState<Mode>('choice');

  return (
    <div className="flex flex-1 flex-col gap-4 p-5">
      {mode === 'choice' && <Choice onSelect={setMode} />}
      {mode === 'create' && <CreateFlow onBack={() => setMode('choice')} />}
      {mode === 'import' && <ImportFlow onBack={() => setMode('choice')} />}
    </div>
  );
}

function Choice({ onSelect }: { onSelect: (mode: Mode) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div>
        <div className="mb-3 text-4xl">◆</div>
        <ScreenTitle>AI Wallet</ScreenTitle>
        <p className="mt-2 text-sm text-zinc-400">
          Non-custodial гаманець, який пояснює транзакції простою мовою і попереджає про
          ризики.
        </p>
      </div>
      <div className="flex w-full flex-col gap-3">
        <Button onClick={() => onSelect('create')}>Створити новий гаманець</Button>
        <Button variant="secondary" onClick={() => onSelect('import')}>
          Імпортувати наявний
        </Button>
      </div>
      <p className="text-xs text-zinc-600">
        Ключі зберігаються лише на вашому пристрої, зашифровані паролем.
      </p>
    </div>
  );
}

function CreateFlow({ onBack }: { onBack: () => void }) {
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const [step, setStep] = useState<'password' | 'backup'>('password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mnemonic, setMnemonic] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toBackup = async () => {
    if (password.length < 8) {
      setError('Пароль має містити щонайменше 8 символів.');
      return;
    }
    if (password !== confirm) {
      setError('Паролі не збігаються.');
      return;
    }
    setError(null);
    setMnemonic(await walletCore.generateMnemonic(12));
    setStep('backup');
  };

  const finish = async () => {
    setBusy(true);
    try {
      const account = await walletCore.createWallet(mnemonic, password);
      await completeOnboarding(account);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося створити гаманець.');
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <ScreenTitle>Створення гаманця</ScreenTitle>
        <p className="text-sm text-zinc-400">
          Пароль шифрує сховище на цьому пристрої (Argon2id + AES-256-GCM у ядрі).
        </p>
        <Field
          label="Пароль"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Мінімум 8 символів"
        />
        <Field
          label="Повторіть пароль"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error !== null && <p className="text-xs text-red-400">{error}</p>}
        <div className="mt-auto flex flex-col gap-2">
          <Button onClick={() => void toBackup()}>Далі</Button>
          <Button variant="ghost" onClick={onBack}>
            Назад
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ScreenTitle>Резервна фраза</ScreenTitle>
      <p className="text-sm text-zinc-400">
        Запишіть 12 слів у надійному місці. Це єдиний спосіб відновити гаманець (F1.1).
      </p>
      <Card>
        <ol className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
          {mnemonic.map((word, i) => (
            <li key={`${i}-${word}`} className="flex gap-1.5">
              <span className="w-4 text-right text-zinc-600">{i + 1}.</span>
              <span className="font-mono text-zinc-200">{word}</span>
            </li>
          ))}
        </ol>
      </Card>
      <label className="flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 accent-emerald-500"
        />
        Я записав(ла) фразу і розумію, що її втрата означає втрату коштів.
      </label>
      {error !== null && <p className="text-xs text-red-400">{error}</p>}
      <div className="mt-auto flex flex-col gap-2">
        <Button disabled={!saved || busy} onClick={() => void finish()}>
          {busy ? 'Створення…' : 'Завершити'}
        </Button>
        <Button variant="ghost" onClick={() => setStep('password')}>
          Назад
        </Button>
      </div>
    </div>
  );
}

function ImportFlow({ onBack }: { onBack: () => void }) {
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const [source, setSource] = useState<'mnemonic' | 'privateKey'>('mnemonic');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    setError(null);
    if (password.length < 8) {
      setError('Пароль має містити щонайменше 8 символів.');
      return;
    }
    setBusy(true);
    try {
      if (source === 'privateKey') {
        // TODO: імпорт приватного ключа per-chain (F1.2) — після інтеграції WASM.
        throw new Error('Імпорт приватного ключа буде доступний після інтеграції ядра.');
      }
      const words = phrase.trim().toLowerCase().split(/\s+/);
      const account = await walletCore.importWallet(words, password);
      await completeOnboarding(account);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося імпортувати.');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ScreenTitle>Імпорт гаманця</ScreenTitle>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant={source === 'mnemonic' ? 'primary' : 'secondary'}
          onClick={() => setSource('mnemonic')}
        >
          Seed-фраза
        </Button>
        <Button
          variant={source === 'privateKey' ? 'primary' : 'secondary'}
          onClick={() => setSource('privateKey')}
        >
          Приватний ключ
        </Button>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">
          {source === 'mnemonic' ? 'Seed-фраза (12 або 24 слова)' : 'Приватний ключ'}
        </span>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          rows={3}
          placeholder={source === 'mnemonic' ? 'слово слово слово …' : '0x…'}
          className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-emerald-500/70"
        />
      </label>
      <Field
        label="Новий пароль"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Мінімум 8 символів"
      />
      {error !== null && <p className="text-xs text-red-400">{error}</p>}
      <div className="mt-auto flex flex-col gap-2">
        <Button disabled={busy || phrase.trim().length === 0} onClick={() => void doImport()}>
          {busy ? 'Імпорт…' : 'Імпортувати'}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Назад
        </Button>
      </div>
    </div>
  );
}
