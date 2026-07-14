/**
 * Екран згоди на передачу даних — CONSENT-ГЕЙТ ДО ПЕРШОЇ ПЕРЕДАЧІ.
 *
 * Chrome Web Store вимагає не лише розкриття збору даних у лістингу, а й ЯВНУ
 * згоду користувача В UI розширення ДО того, як дані вперше підуть із
 * пристрою. Firefox тим часом вимагає декларації категорій у маніфесті
 * (data_collection_permissions, wxt.config.ts) — цей екран робить декларацію
 * «optional: personalCommunications» правдивою: AI справді можна не вмикати.
 *
 * Коли показується (роутинг — entrypoints/popup/App.tsx):
 *  - firstRun — новий користувач: перший крок онбордингу, ДО створення гаманця;
 *  - update   — наявний користувач після оновлення політики (CONSENT_VERSION);
 *  - review   — «Ще → Приватність і дані → Які дані ми надсилаємо».
 *
 * Тон: без темних патернів. «Погодитись» — акцентна кнопка, «Продовжити без
 * передачі даних» — рівноцінна secondary-кнопка поруч, а не сірий текст унизу;
 * AI-чекбокс за замовчуванням ВИМКНЕНИЙ (opt-in, не opt-out). Зміст —
 * стислий переказ docs/PRIVACY.md §1–3, без прикрашань.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandMark, IconShield } from '@/src/components/icons';
import { Button, Card, Eyebrow, ScreenTitle, Toggle } from '@/src/components/ui';
import { openPrivacyPolicy, saveConsent, type DataConsent } from '@/src/lib/consent';
import { useWalletStore } from '@/src/store/wallet';

export type ConsentMode = 'firstRun' | 'update' | 'review';

const EYEBROW_KEY: Record<ConsentMode, string> = {
  firstRun: 'consent.eyebrowFirstRun',
  update: 'consent.eyebrowUpdate',
  review: 'settings.privacy',
};

export default function DataConsent({
  mode,
  current,
}: {
  mode: ConsentMode;
  /** Чинне рішення (режим review) — щоб тумблери показували поточний стан. */
  current: DataConsent | null;
}) {
  const { t } = useTranslation();
  const closeConsentReview = useWalletStore((s) => s.closeConsentReview);
  // AI — opt-in: за замовчуванням ВИМКНЕНО. У review тумблер показує чинний стан.
  const [ai, setAi] = useState(current?.ai ?? false);
  const [network, setNetwork] = useState(current?.network ?? false);
  const [busy, setBusy] = useState(false);

  const decide = async (choice: { network: boolean; ai: boolean }) => {
    setBusy(true);
    await saveConsent(choice);
    // Рішення записане: App.tsx перемкне екран сам (підписка на consent).
    if (mode === 'review') closeConsentReview();
    setBusy(false);
  };

  return (
    <div className="screen-in flex h-full flex-col overflow-y-auto p-5 pb-4">
      <header>
        {mode === 'firstRun' && (
          <div className="mb-4 flex flex-col items-center text-center">
            <BrandMark size={44} />
          </div>
        )}
        <Eyebrow className="mb-1">{t(EYEBROW_KEY[mode])}</Eyebrow>
        <ScreenTitle>{t('consent.title')}</ScreenTitle>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">{t('consent.intro')}</p>
        {mode === 'update' && (
          <p className="mt-2.5 rounded-[10px] border border-accent/40 bg-accent/5 px-3.5 py-2.5 text-xs leading-relaxed text-ink">
            {t('consent.updateNote')}
          </p>
        )}
      </header>

      <div className="mt-5 flex flex-col gap-4">
        {/* 1. Те, що НІКОЛИ не залишає пристрій — першим: це головний факт
            про non-custodial гаманець, а не дрібний шрифт унизу. */}
        <Card className="p-0">
          <div className="flex items-start gap-3 border-b border-hairline px-4 py-3">
            <IconShield size={17} className="mt-0.5 shrink-0 text-positive" />
            <p className="text-sm font-medium text-ink">{t('consent.localTitle')}</p>
          </div>
          <p className="px-4 py-3 text-xs leading-relaxed text-muted">{t('consent.localItems')}</p>
        </Card>

        {/* 2. Що йде на наш бекенд (обов'язковий обсяг). */}
        <section>
          <Eyebrow className="mb-2.5">{t('consent.backendTitle')}</Eyebrow>
          <Card className="p-0">
            {[
              'consent.backendAddresses',
              'consent.backendTx',
              'consent.backendSigned',
              'consent.backendIp',
            ].map((key, index) => (
              <p
                key={key}
                className={`px-4 py-2.5 text-xs leading-relaxed text-muted ${
                  index > 0 ? 'border-t border-hairline' : ''
                }`}
              >
                {t(key)}
              </p>
            ))}
          </Card>
        </section>

        {/* 3. Кому бекенд передає дані далі. */}
        <section>
          <Eyebrow className="mb-2.5">{t('consent.thirdPartyTitle')}</Eyebrow>
          <Card className="p-0">
            {['consent.thirdPartyAi', 'consent.thirdPartyRpc', 'consent.thirdPartyPrices'].map(
              (key, index) => (
                <p
                  key={key}
                  className={`px-4 py-2.5 text-xs leading-relaxed text-muted ${
                    index > 0 ? 'border-t border-hairline' : ''
                  }`}
                >
                  {t(key)}
                </p>
              ),
            )}
          </Card>
        </section>

        {/* 4. Рішення. review — два тумблери; перший показ — чекбокс AI. */}
        {mode === 'review' ? (
          <Card className="p-0">
            <Toggle
              label={t('settings.dataSharing')}
              hint={t('settings.dataSharingHint')}
              checked={network}
              onChange={(next) => {
                setNetwork(next);
                if (!next) setAi(false); // AI без бекенду неможливий
              }}
            />
            <div className="border-t border-hairline">
              <Toggle
                label={t('settings.aiFeatures')}
                hint={network ? t('settings.aiFeaturesHint') : t('settings.aiRequiresData')}
                checked={ai}
                disabled={!network}
                onChange={setAi}
              />
            </div>
          </Card>
        ) : (
          <section>
            <Eyebrow className="mb-2.5">{t('consent.aiTitle')}</Eyebrow>
            <Card>
              <p className="text-xs leading-relaxed text-muted">{t('consent.aiHint')}</p>
              <label className="mt-3 flex items-start gap-2.5 text-sm leading-snug text-ink">
                <input
                  type="checkbox"
                  checked={ai}
                  onChange={(e) => setAi(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                {t('consent.aiToggle')}
              </label>
              <p className="mt-2 text-xs leading-relaxed text-muted/80">
                {t('consent.aiToggleHint')}
              </p>
            </Card>
          </section>
        )}

        {/* Нова ВКЛАДКА (browser.tabs.create), а не навігація всередині попапа:
            інакше екран згоди зникає разом із незбереженим вибором. */}
        <button
          type="button"
          onClick={openPrivacyPolicy}
          className="w-fit text-start text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {t('consent.policyLink')}
        </button>
      </div>

      {/* Дії. Обидва варіанти — справжні кнопки однакового розміру: відмова не
          «ховається» у сірий текст (політики стор і здоровий глузд). */}
      <div className="mt-6 flex flex-col gap-2 pt-2">
        {mode === 'review' ? (
          <>
            <Button disabled={busy} onClick={() => void decide({ network, ai })}>
              {t('common.save')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={closeConsentReview}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void decide({ network: true, ai })}>
              {t('consent.accept')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void decide({ network: false, ai: false })}
            >
              {t('consent.decline')}
            </Button>
            <p className="mt-1 text-xs leading-relaxed text-muted/80">{t('consent.declineHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
