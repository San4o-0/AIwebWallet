/**
 * Флоу «Забули пароль?» (з екрана Unlock) — повноекранний степер без нижньої
 * навігації, як онбординг у режимі додавання.
 *
 * Пароль не зберігається і не відновлюється за дизайном; головний ключ —
 * seed-фраза. Кроки:
 *   1) чесне пояснення + теракотове попередження про втрату коштів без фрази;
 *   2) введення фрази (12/24 слова) з верифікацією, що вона належить САМЕ
 *      активному гаманцю: деривовані у WASM адреси (index 0) звіряються з
 *      ПУБЛІЧНОЮ EVM-адресою запису; чужа фраза — конкретна помилка і явна
 *      опція «Відновити як новий гаманець» (звичайне додавання);
 *   3) новий пароль (двічі, ті самі правила, що в онбордингу).
 *
 * Завершення: background (RestoreVaultPassword) повторно верифікує фразу,
 * створює новий шифротекст і замінює його в ТОМУ САМОМУ VaultRecord
 * (id/name/accounts зберігаються), розблоковує сесію → Home. Фраза в стейті
 * попапа затирається одразу після завершення (наскільки дозволяє JS).
 */
import { useState } from 'react';

import { Button, Field, SeedPhraseTextarea, StepHeader } from '@/src/components/ui';
import { shortenAddress } from '@/src/lib/format';
import { walletCore } from '@/src/lib/wallet-core';
import { findActiveWallet, useWalletStore } from '@/src/store/wallet';
import { loadWalletCoreWasm, toWasmError } from '@/src/wasm';

type Step = 'explain' | 'phrase' | 'password';

/** Нормалізовані слова фрази (зайві пробіли/регістр не ламають ввід). */
function toWords(phrase: string): string[] {
  const trimmed = phrase.trim().toLowerCase();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export default function RestoreWallet() {
  const cancelRestorePassword = useWalletStore((s) => s.cancelRestorePassword);
  const restorePassword = useWalletStore((s) => s.restorePassword);
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const wallets = useWalletStore((s) => s.wallets);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const activeWallet = findActiveWallet(wallets, activeWalletId);

  const [step, setStep] = useState<Step>('explain');
  const [phrase, setPhrase] = useState('');
  /** Фраза валідна, але від іншого гаманця → пропозиція «як новий гаманець». */
  const [mismatch, setMismatch] = useState(false);
  /** Обрано явну опцію «Відновити як новий гаманець» (звичайне додавання). */
  const [asNewWallet, setAsNewWallet] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Затерти секрети зі стейту попапа (наскільки дозволяє JS). */
  const wipeSecrets = () => {
    setPhrase('');
    setPassword('');
    setConfirm('');
  };

  const cancel = () => {
    wipeSecrets();
    cancelRestorePassword();
  };

  // --- Крок 2: валідація фрази + верифікація належності цьому гаманцю ------
  const verifyPhrase = async () => {
    setError(null);
    setMismatch(false);
    const words = toWords(phrase);
    if (words.length !== 12 && words.length !== 24) {
      setError('Seed-фраза має містити 12 або 24 слова.');
      return;
    }
    setBusy(true);
    try {
      const wasm = await loadWalletCoreWasm();
      const joined = words.join(' ');
      if (!wasm.validateMnemonic(joined)) {
        setError(
          'Невірна seed-фраза: слово поза словником BIP-39 або checksum не збігається.',
        );
        return;
      }
      // Належність фрази САМЕ цьому гаманцю: деривована EVM-адреса акаунта 0
      // проти публічної адреси активного запису (accounts зберігаються
      // відкрито). Background повторить цю перевірку авторитетно.
      const derived = JSON.parse(wasm.deriveAddresses(joined, 0)) as { evm: string };
      const knownEvm = activeWallet?.primaryEvmAddress ?? null;
      if (knownEvm !== null && derived.evm.toLowerCase() !== knownEvm.toLowerCase()) {
        setMismatch(true);
        setError('Ця фраза належить іншому гаманцю. Перевірте слова.');
        return;
      }
      setAsNewWallet(false);
      setStep('password');
    } catch (e) {
      setError(toWasmError(e).message);
    } finally {
      setBusy(false);
    }
  };

  // --- Крок 3: новий пароль (правила онбордингу) → завершення ---------------
  const finish = async () => {
    if (password.length < 8) {
      setError('Пароль має містити щонайменше 8 символів.');
      return;
    }
    if (password !== confirm) {
      setError('Паролі не збігаються.');
      return;
    }
    setError(null);
    setBusy(true);
    const words = toWords(phrase);
    try {
      if (asNewWallet) {
        // Явно обране «Відновити як новий гаманець» — звичайне додавання
        // нового незалежного гаманця з цією фразою і власним паролем.
        const account = await walletCore.importWallet(words, password);
        wipeSecrets();
        await completeOnboarding(account);
        return;
      }
      const failure = await restorePassword(words, password);
      if (failure === null) {
        // Успіх: сесію розблоковано, стор уже перемкнув на Home.
        wipeSecrets();
        return;
      }
      if (failure.code === 'wallet-mismatch') {
        // Background не підтвердив належність — назад до кроку фрази з
        // конкретною помилкою і опцією «як новий гаманець».
        setMismatch(true);
        setStep('phrase');
      }
      setError(failure.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося відновити гаманець.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      {step === 'explain' && (
        <div className="flex min-h-full flex-1 flex-col gap-5">
          <StepHeader
            step={1}
            total={3}
            section="Відновлення доступу"
            title="Забули пароль?"
          />
          <p className="text-sm leading-relaxed text-muted">
            Пароль не зберігається і не відновлюється. Але гаманець можна
            відновити seed-фразою: введіть фразу цього гаманця і задайте новий
            пароль.
          </p>
          {activeWallet !== null && (
            <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
              <p className="text-sm font-semibold text-ink">{activeWallet.name}</p>
              {activeWallet.primaryEvmAddress !== null && (
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {shortenAddress(activeWallet.primaryEvmAddress)}
                </p>
              )}
            </div>
          )}
          <div className="rounded-[14px] border border-terra/40 bg-terra/5 p-3.5">
            <p className="text-xs font-medium leading-relaxed text-terra">
              Якщо seed-фрази немає — доступ до коштів цього гаманця втрачено:
              без фрази розшифрувати сховище неможливо.
            </p>
          </div>
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button onClick={() => setStep('phrase')}>У мене є фраза</Button>
            <Button variant="ghost" onClick={cancel}>
              Назад
            </Button>
          </div>
        </div>
      )}

      {step === 'phrase' && (
        <div className="flex min-h-full flex-1 flex-col gap-5">
          <StepHeader step={2} total={3} section="Відновлення доступу" title="Seed-фраза" />
          <p className="text-sm leading-relaxed text-muted">
            Введіть фразу гаманця
            {activeWallet !== null ? ` «${activeWallet.name}»` : ''} — 12 або 24
            слова через пробіл. Фраза не покидає пристрій.
          </p>
          <SeedPhraseTextarea
            label="Seed-фраза (12 або 24 слова)"
            value={phrase}
            autoFocus
            onChange={(e) => {
              setPhrase(e.target.value);
              setMismatch(false);
              setError(null);
            }}
          />
          {error !== null && <p className="text-xs text-terra">{error}</p>}
          {mismatch && (
            <div className="animate-rise rounded-[14px] border border-terra/40 bg-terra/5 p-3.5">
              <p className="text-xs leading-relaxed text-ink">
                Адреси цієї фрази не збігаються з гаманцем
                {activeWallet !== null ? ` «${activeWallet.name}»` : ''}. Якщо це
                інша ваша фраза — можна додати її як окремий новий гаманець
                (наявні записи не зміняться).
              </p>
              <Button
                variant="secondary"
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => {
                  setAsNewWallet(true);
                  setError(null);
                  setStep('password');
                }}
              >
                Відновити як новий гаманець
              </Button>
            </div>
          )}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button
              disabled={busy || toWords(phrase).length === 0}
              onClick={() => void verifyPhrase()}
            >
              {busy ? 'Перевірка…' : 'Далі'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('explain')}>
              Назад
            </Button>
          </div>
        </div>
      )}

      {step === 'password' && (
        <div className="flex min-h-full flex-1 flex-col gap-5">
          <StepHeader
            step={3}
            total={3}
            section="Відновлення доступу"
            title={asNewWallet ? 'Пароль нового гаманця' : 'Новий пароль'}
          />
          <p className="text-sm leading-relaxed text-muted">
            {asNewWallet
              ? 'Фраза буде додана як окремий гаманець із власним паролем. Наявні гаманці залишаться без змін.'
              : 'Новий пароль зашифрує сховище цього гаманця замість забутого (Argon2id + AES-256-GCM). Назва й адреси залишаться тими самими.'}
          </p>
          <Field
            label="Новий пароль"
            type="password"
            autoFocus
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
          {error !== null && <p className="text-xs text-terra">{error}</p>}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button disabled={busy} onClick={() => void finish()}>
              {busy
                ? 'Відновлення…'
                : asNewWallet
                  ? 'Додати гаманець'
                  : 'Задати пароль і розблокувати'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPassword('');
                setConfirm('');
                setError(null);
                setStep('phrase');
              }}
            >
              Назад
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
