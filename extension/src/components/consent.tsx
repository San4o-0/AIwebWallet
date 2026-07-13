/**
 * React-обв'язка навколо src/lib/consent.ts: хук стану згоди + два стани
 * порожнечі, якими екрани чесно пояснюють, ЧОМУ даних немає.
 *
 * lib/consent.ts свідомо без React (бандлиться в background) — усе, що знає
 * про рендер, живе тут.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Eyebrow } from '@/src/components/ui';
import { readConsent, subscribeConsent, type DataConsent } from '@/src/lib/consent';
import { useWalletStore } from '@/src/store/wallet';

interface ConsentState {
  /** null — рішення ще немає (або політика оновилась). */
  consent: DataConsent | null;
  /** true, доки читаємо storage: до цього моменту НЕ рендеримо гаманець. */
  loading: boolean;
}

/** Поточне рішення про передачу даних (реактивно: попап ↔ background). */
export function useDataConsent(): ConsentState {
  const [state, setState] = useState<ConsentState>({ consent: null, loading: true });

  useEffect(() => {
    let alive = true;
    void readConsent().then((consent) => {
      if (alive) setState({ consent, loading: false });
    });
    return subscribeConsent((consent) => {
      if (alive) setState({ consent, loading: false });
    });
  }, []);

  return state;
}

/** Чи можна звертатись до бекенду (баланси, історія, аналітика, надсилання). */
export function useNetworkAllowed(): boolean {
  return useDataConsent().consent?.network === true;
}

/** Чи можна передавати дані AI-провайдеру (пояснення, чат). */
export function useAiAllowed(): boolean {
  const { consent } = useDataConsent();
  return consent !== null && consent.network && consent.ai;
}

/**
 * Офлайн-режим: користувач не дав згоди на передачу даних. Показуємо це
 * замість «бекенд недоступний» — це не збій, а його власний вибір, і його
 * можна змінити тут же.
 */
export function NetworkOffNote() {
  const { t } = useTranslation();
  const openConsentReview = useWalletStore((s) => s.openConsentReview);

  return (
    <Card className="animate-rise">
      <Eyebrow className="mb-1.5">{t('settings.privacy')}</Eyebrow>
      <p className="text-sm leading-relaxed text-ink">{t('consent.offlineTitle')}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('consent.offlineHint')}</p>
      <Button variant="secondary" className="mt-3.5 w-full" onClick={openConsentReview}>
        {t('consent.offlineEnable')}
      </Button>
    </Card>
  );
}

/** AI-функції вимкнено (opt-in): екран Чату не шле запитів. */
export function AiOffNote() {
  const { t } = useTranslation();
  const openConsentReview = useWalletStore((s) => s.openConsentReview);

  return (
    <Card className="animate-rise">
      <Eyebrow className="mb-1.5">{t('settings.privacy')}</Eyebrow>
      <p className="text-sm leading-relaxed text-ink">{t('consent.aiOffTitle')}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('consent.aiOffHint')}</p>
      <Button variant="secondary" className="mt-3.5 w-full" onClick={openConsentReview}>
        {t('consent.aiOffEnable')}
      </Button>
    </Card>
  );
}
