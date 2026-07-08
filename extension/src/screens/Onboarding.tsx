/**
 * Онбординг: створення нового гаманця або імпорт (F1.1, F1.2).
 * Крипто-операції виконує WASM-ядро (crates/wallet-core): реальна генерація
 * BIP-39 фрази у popup, створення зашифрованого vault (Argon2id + AES-GCM) —
 * у background; у chrome.storage.local потрапляє лише шифротекст.
 *
 * Дизайн: крокований потік «приватного банку»; seed-фраза показується як
 * документ — нумерований список слів у mono на картці з hairline-рамкою.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandMark } from '@/src/components/icons';
import {
  Button,
  Eyebrow,
  Field,
  ScreenTitle,
  SeedPhraseTextarea,
  StepHeader,
} from '@/src/components/ui';
import { localizeUnknownError } from '@/src/i18n';
import { walletCore } from '@/src/lib/wallet-core';
import { useWalletStore } from '@/src/store/wallet';

type Mode = 'choice' | 'create' | 'import';

export default function Onboarding() {
  // Режим «додати гаманець» (із Settings): без вітальних кроків — одразу
  // вибір «створити/імпортувати»; наявні гаманці не чіпаються, у нового —
  // СВІЙ пароль.
  const addingWallet = useWalletStore((s) => s.addingWallet);
  const [mode, setMode] = useState<Mode>('choice');

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      {mode === 'choice' &&
        (addingWallet ? <AddWalletChoice onSelect={setMode} /> : <Choice onSelect={setMode} />)}
      {mode === 'create' && <CreateFlow onBack={() => setMode('choice')} />}
      {mode === 'import' && <ImportFlow onBack={() => setMode('choice')} />}
    </div>
  );
}

function Choice({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
      <div className="animate-rise flex flex-col items-center">
        <BrandMark size={52} />
        <h1 className="mt-5 font-display text-[28px] font-semibold leading-none text-ink">
          {t('common.appName')}
        </h1>
        <div className="mt-4 h-px w-24 bg-accent/60" aria-hidden />
        <Eyebrow className="mt-2">{t('onboarding.tagline')}</Eyebrow>
        <p className="mt-4 max-w-[280px] text-sm leading-relaxed text-muted">
          {t('onboarding.intro')}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        <Button onClick={() => onSelect('create')}>{t('onboarding.createNew')}</Button>
        <Button variant="secondary" onClick={() => onSelect('import')}>
          {t('onboarding.importExisting')}
        </Button>
      </div>
      <p className="max-w-[280px] text-xs leading-relaxed text-muted/80">
        {t('onboarding.keysNote')}
      </p>
    </div>
  );
}

/** Компактний вибір для режиму «додати гаманець» — без вітальної обкладинки. */
function AddWalletChoice({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const { t } = useTranslation();
  const cancelAddWallet = useWalletStore((s) => s.cancelAddWallet);

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      <header>
        <Eyebrow className="mb-1">{t('onboarding.add.eyebrow')}</Eyebrow>
        <ScreenTitle>{t('onboarding.add.title')}</ScreenTitle>
      </header>
      <p className="text-sm leading-relaxed text-muted">{t('onboarding.add.description')}</p>
      <div className="flex flex-col gap-2.5">
        <Button onClick={() => onSelect('create')}>{t('onboarding.createNew')}</Button>
        <Button variant="secondary" onClick={() => onSelect('import')}>
          {t('onboarding.add.importSeed')}
        </Button>
      </div>
      <div className="mt-auto pt-4">
        <Button variant="ghost" className="w-full" onClick={cancelAddWallet}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function CreateFlow({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const addingWallet = useWalletStore((s) => s.addingWallet);
  const [step, setStep] = useState<'password' | 'backup'>('password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mnemonic, setMnemonic] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toBackup = async () => {
    if (password.length < 8) {
      setError(t('errors.passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('errors.passwordsMismatch'));
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
      setError(localizeUnknownError(e, 'errors.createWalletFailed'));
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <div className="flex min-h-full flex-1 flex-col gap-5">
        <StepHeader
          step={1}
          total={2}
          section={t('onboarding.create.section')}
          title={addingWallet ? t('wallets.newWalletPassword') : t('onboarding.create.title')}
        />
        <p className="text-sm leading-relaxed text-muted">
          {addingWallet
            ? t('onboarding.create.passwordHintAdd')
            : t('onboarding.create.passwordHint')}
        </p>
        <Field
          label={t('common.passwordLabel')}
          type="password"
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
          <Button onClick={() => void toBackup()}>{t('common.next')}</Button>
          <Button variant="ghost" onClick={onBack}>
            {t('common.back')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      <StepHeader
        step={2}
        total={2}
        section={t('onboarding.create.backupSection')}
        title={t('onboarding.create.backupTitle')}
      />
      <p className="text-sm leading-relaxed text-muted">{t('onboarding.create.backupHint')}</p>

      {/* Seed-фраза як документ: hairline-рамка, нумерований mono-список */}
      <div className="animate-rise rounded-[10px] border border-hairline bg-surface">
        <div className="flex items-baseline justify-between border-b border-hairline px-4 py-2.5">
          <Eyebrow>{t('onboarding.create.recoveryDoc')}</Eyebrow>
          <span className="eyebrow text-[10px]">
            {t('onboarding.create.wordCount', { count: mnemonic.length })}
          </span>
        </div>
        <ol className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-5 py-4" dir="ltr">
          {mnemonic.map((word, i) => (
            <li key={`${i}-${word}`} className="flex items-baseline gap-2.5">
              <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted/70">
                {i + 1}
              </span>
              <span className="font-mono text-[13px] text-ink">{word}</span>
            </li>
          ))}
        </ol>
        <div className="border-t border-hairline px-4 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted">
            {t('onboarding.create.neverShare')}
          </p>
        </div>
      </div>

      <label className="flex items-start gap-2.5 text-sm leading-snug text-ink">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 size-4 accent-accent"
        />
        {t('onboarding.create.savedConfirm')}
      </label>
      {error !== null && <p className="text-xs text-danger">{error}</p>}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button disabled={!saved || busy} onClick={() => void finish()}>
          {busy ? t('onboarding.create.creating') : t('onboarding.create.finish')}
        </Button>
        <Button variant="ghost" onClick={() => setStep('password')}>
          {t('common.back')}
        </Button>
      </div>
    </div>
  );
}

function ImportFlow({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const completeOnboarding = useWalletStore((s) => s.completeOnboarding);
  const addingWallet = useWalletStore((s) => s.addingWallet);
  const [source, setSource] = useState<'mnemonic' | 'privateKey'>('mnemonic');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    setError(null);
    if (password.length < 8) {
      setError(t('errors.passwordTooShort'));
      return;
    }
    setBusy(true);
    try {
      if (source === 'privateKey') {
        // TODO: імпорт приватного ключа per-chain (F1.2) — після інтеграції WASM.
        throw new Error('errors.privateKeyImportSoon');
      }
      const words = phrase.trim().toLowerCase().split(/\s+/);
      const account = await walletCore.importWallet(words, password);
      await completeOnboarding(account);
    } catch (e) {
      setError(localizeUnknownError(e, 'errors.importFailed'));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      <StepHeader
        step={1}
        total={1}
        section={t('onboarding.import.section')}
        title={t('onboarding.import.title')}
      />

      {/* Перемикач джерела */}
      <div
        className="grid grid-cols-2 gap-1 rounded-xl border border-hairline bg-surface p-1"
        role="tablist"
        aria-label={t('onboarding.import.sourceAria')}
      >
        {(
          [
            { id: 'mnemonic', label: t('onboarding.import.seedTab') },
            { id: 'privateKey', label: t('onboarding.import.keyTab') },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={source === option.id}
            onClick={() => setSource(option.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              source === option.id
                ? 'bg-raised text-accent'
                : 'text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <SeedPhraseTextarea
        label={
          source === 'mnemonic' ? t('onboarding.import.seedLabel') : t('onboarding.import.keyLabel')
        }
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder={source === 'mnemonic' ? undefined : '0x…'}
      />
      <Field
        label={addingWallet ? t('wallets.newWalletPassword') : t('restore.newPassword')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('common.passwordPlaceholder')}
      />
      {error !== null && <p className="text-xs text-danger">{error}</p>}
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <Button disabled={busy || phrase.trim().length === 0} onClick={() => void doImport()}>
          {busy ? t('onboarding.import.importing') : t('onboarding.import.submit')}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>
      </div>
    </div>
  );
}
