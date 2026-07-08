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
import { useTranslation } from 'react-i18next';

import { Button, Field, SeedPhraseTextarea, StepHeader } from '@/src/components/ui';
import { localizeUnknownError } from '@/src/i18n';
import { shortenAddress } from '@/src/lib/format';
import { MAX_WALLETS } from '@/src/lib/vault-storage';
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
  const { t } = useTranslation();
  const cancelRestorePassword = useWalletStore((s) => s.cancelRestorePassword);
  const restorePassword = useWalletStore((s) => s.restorePassword);
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const startAddWallet = useWalletStore((s) => s.startAddWallet);
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
      setError(t('errors.phraseWordCount'));
      return;
    }
    setBusy(true);
    try {
      const wasm = await loadWalletCoreWasm();
      const joined = words.join(' ');
      if (!wasm.validateMnemonic(joined)) {
        setError(t('errors.invalidMnemonic'));
        return;
      }
      // Належність фрази САМЕ цьому гаманцю: деривована EVM-адреса акаунта 0
      // проти публічної адреси активного запису (accounts зберігаються
      // відкрито). Background повторить цю перевірку авторитетно.
      const derived = JSON.parse(wasm.deriveAddresses(joined, 0)) as { evm: string };
      const knownEvm = activeWallet?.primaryEvmAddress ?? null;
      if (knownEvm !== null && derived.evm.toLowerCase() !== knownEvm.toLowerCase()) {
        setMismatch(true);
        setError(t('errors.phraseOtherWallet'));
        return;
      }
      setAsNewWallet(false);
      setStep('password');
    } catch (e) {
      setError(localizeUnknownError(toWasmError(e), 'errors.restoreFailed'));
    } finally {
      setBusy(false);
    }
  };

  // --- Крок 3: новий пароль (правила онбордингу) → завершення ---------------
  const finish = async () => {
    if (password.length < 8) {
      setError(t('errors.passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('errors.passwordsMismatch'));
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
      setError(localizeUnknownError(e, 'errors.restoreFailed'));
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
            section={t('restore.section')}
            title={t('restore.explainTitle')}
          />
          <p className="text-sm leading-relaxed text-muted">{t('restore.explainText')}</p>
          {activeWallet !== null && (
            <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
              <p className="text-sm font-semibold text-ink">{activeWallet.name}</p>
              {activeWallet.primaryEvmAddress !== null && (
                <p className="mt-0.5 font-mono text-xs text-muted" dir="ltr">
                  {shortenAddress(activeWallet.primaryEvmAddress)}
                </p>
              )}
            </div>
          )}
          <div className="rounded-[10px] border border-danger/40 bg-danger/5 p-3.5">
            <p className="text-xs font-medium leading-relaxed text-danger">
              {t('restore.noPhraseWarning')}
            </p>
          </div>
          {/* Вихід для тих, хто без фрази: новий незалежний гаманець через
              звичайний флоу додавання; заблокований запис лишається в списку.
              При досягненні ліміту гаманців опція зникає. */}
          {wallets.length < MAX_WALLETS && (
            <div className="rounded-[10px] border border-hairline bg-surface p-3.5">
              <p className="text-xs leading-relaxed text-muted">{t('restore.createNewHint')}</p>
              <Button
                variant="secondary"
                className="mt-3 w-full"
                onClick={() => {
                  wipeSecrets();
                  startAddWallet();
                }}
              >
                {t('onboarding.createNew')}
              </Button>
            </div>
          )}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button onClick={() => setStep('phrase')}>{t('restore.havePhrase')}</Button>
            <Button variant="ghost" onClick={cancel}>
              {t('common.back')}
            </Button>
          </div>
        </div>
      )}

      {step === 'phrase' && (
        <div className="flex min-h-full flex-1 flex-col gap-5">
          <StepHeader
            step={2}
            total={3}
            section={t('restore.section')}
            title={t('restore.phraseTitle')}
          />
          <p className="text-sm leading-relaxed text-muted">
            {activeWallet !== null
              ? t('restore.phraseHintNamed', { name: activeWallet.name })
              : t('restore.phraseHint')}
          </p>
          <SeedPhraseTextarea
            label={t('onboarding.import.seedLabel')}
            value={phrase}
            autoFocus
            onChange={(e) => {
              setPhrase(e.target.value);
              setMismatch(false);
              setError(null);
            }}
          />
          {error !== null && <p className="text-xs text-danger">{error}</p>}
          {mismatch && (
            <div className="animate-rise rounded-[10px] border border-danger/40 bg-danger/5 p-3.5">
              <p className="text-xs leading-relaxed text-ink">
                {activeWallet !== null
                  ? t('restore.mismatchNamed', { name: activeWallet.name })
                  : t('restore.mismatch')}
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
                {t('restore.restoreAsNew')}
              </Button>
            </div>
          )}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button
              disabled={busy || toWords(phrase).length === 0}
              onClick={() => void verifyPhrase()}
            >
              {busy ? t('restore.verifying') : t('common.next')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('explain')}>
              {t('common.back')}
            </Button>
          </div>
        </div>
      )}

      {step === 'password' && (
        <div className="flex min-h-full flex-1 flex-col gap-5">
          <StepHeader
            step={3}
            total={3}
            section={t('restore.section')}
            title={asNewWallet ? t('wallets.newWalletPassword') : t('restore.newPassword')}
          />
          <p className="text-sm leading-relaxed text-muted">
            {asNewWallet ? t('restore.asNewHint') : t('restore.newPasswordHint')}
          </p>
          <Field
            label={t('restore.newPassword')}
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('common.passwordPlaceholder')}
          />
          <Field
            label={t('common.passwordRepeatLabel')}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error !== null && <p className="text-xs text-danger">{error}</p>}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <Button disabled={busy} onClick={() => void finish()}>
              {busy
                ? t('restore.restoring')
                : asNewWallet
                  ? t('restore.finishAsNew')
                  : t('restore.finishReplace')}
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
              {t('common.back')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
