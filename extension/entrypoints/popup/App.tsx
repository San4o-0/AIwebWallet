import { useEffect, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { useWalletStore, type Screen } from '@/src/store/wallet';
import {
  IconActivity,
  IconChat,
  IconHome,
  IconMore,
  IconQr,
  type IconProps,
} from '@/src/components/icons';
import { useDataConsent } from '@/src/components/consent';
import { Spinner } from '@/src/components/ui';
import Activity from '@/src/screens/Activity';
import Approve from '@/src/screens/Approve';
import Chat from '@/src/screens/Chat';
import ConnectedSites from '@/src/screens/ConnectedSites';
import DataConsent from '@/src/screens/DataConsent';
import Home from '@/src/screens/Home';
import Onboarding from '@/src/screens/Onboarding';
import Receive from '@/src/screens/Receive';
import RestoreWallet from '@/src/screens/RestoreWallet';
import Send from '@/src/screens/Send';
import Settings from '@/src/screens/Settings';
import Unlock from '@/src/screens/Unlock';

/** Вкладки нижньої навігації (доступні після розблокування). */
const TABS: { screen: Screen; labelKey: string; icon: ComponentType<IconProps> }[] = [
  { screen: 'home', labelKey: 'nav.home', icon: IconHome },
  { screen: 'activity', labelKey: 'nav.activity', icon: IconActivity },
  { screen: 'receive', labelKey: 'nav.receive', icon: IconQr },
  { screen: 'chat', labelKey: 'nav.chat', icon: IconChat },
  { screen: 'settings', labelKey: 'nav.more', icon: IconMore },
];

/**
 * Підекрани, що відкриваються з вкладки і не мають власної кнопки в навігації:
 * вкладка-батько лишається підсвіченою (напр. «Ще» → «Підключені сайти»).
 */
const PARENT_TAB: Partial<Record<Screen, Screen>> = {
  connections: 'settings',
};

/** Окреме вікно підтвердження підпису відкривається з ?view=approve. */
const isApproveView =
  new URLSearchParams(window.location.search).get('view') === 'approve';

export default function App() {
  const { t } = useTranslation();
  const {
    hasWallet,
    unlocked,
    screen,
    setScreen,
    initialize,
    addingWallet,
    restoringPassword,
    consentReview,
  } = useWalletStore();
  const { consent, loading: consentLoading } = useDataConsent();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // ГЕЙТ ЗГОДИ — перед УСІМ, включно з вікном підпису: жоден екран, здатний
  // піти в мережу, не рендериться, доки рішення не прочитане зі storage і не
  // прийняте. (Другий, справжній рубіж — у src/lib/api.ts: навіть якщо якийсь
  // екран пройде повз, запит не стартує.)
  if (consentLoading || hasWallet === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (consent === null) {
    // Гаманця немає — це перший крок онбордингу; гаманець є — одноразовий
    // екран після оновлення політики (CONSENT_VERSION зробив стару згоду
    // недійсною).
    return <DataConsent mode={hasWallet ? 'update' : 'firstRun'} current={null} />;
  }

  // Вікно підтвердження підпису — окремий потік, без навігації.
  // TODO: вимагати розблокування перед показом запиту.
  if (isApproveView) {
    return <Approve />;
  }

  if (!hasWallet) return <Onboarding />;
  // Режим «додати гаманець»: той самий онбординг без вітальних кроків,
  // на весь екран (без нижньої навігації).
  if (addingWallet && screen === 'onboarding') return <Onboarding />;
  // «Забули пароль?»: повноекранний степер відновлення seed-фразою
  // (без нижньої навігації, як онбординг у режимі додавання).
  if (!unlocked) return restoringPassword ? <RestoreWallet /> : <Unlock />;
  // Перегляд/зміна рішення про передачу даних («Ще → Приватність і дані»).
  if (consentReview) return <DataConsent mode="review" current={consent} />;

  const renderScreen = () => {
    switch (screen) {
      case 'send':
        return <Send />;
      case 'activity':
        return <Activity />;
      case 'receive':
        return <Receive />;
      case 'chat':
        return <Chat />;
      case 'settings':
        return <Settings />;
      case 'connections':
        return <ConnectedSites />;
      case 'approve':
        return <Approve />;
      case 'home':
      case 'onboarding':
      case 'unlock':
        return <Home />;
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* Контент скролиться під фіксованим меню; екрани самі додають pb. */}
      <main className="h-full min-h-0 flex-1 overflow-y-auto">{renderScreen()}</main>

      {/* Закріплена нижня навігація */}
      <nav
        aria-label={t('nav.label')}
        className="fixed inset-x-0 bottom-0 z-20 grid h-14 grid-cols-5 border-t border-hairline bg-bg/95 backdrop-blur-sm"
      >
        {TABS.map((tab) => {
          const active = screen === tab.screen || PARENT_TAB[screen] === tab.screen;
          const Icon = tab.icon;
          return (
            <button
              key={tab.screen}
              type="button"
              onClick={() => setScreen(tab.screen)}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium tracking-wide transition-colors ${
                active ? 'text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {/* Латунна риска над активною вкладкою — виростає з центру */}
              <span
                className={`absolute -top-px left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-accent transition-[opacity,transform] duration-150 ${
                  active ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0'
                }`}
              />
              <Icon
                size={19}
                className="transition-transform duration-100 group-active:scale-90"
              />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
