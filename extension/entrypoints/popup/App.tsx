import { useEffect, type ComponentType } from 'react';

import { useWalletStore, type Screen } from '@/src/store/wallet';
import {
  IconActivity,
  IconChat,
  IconHome,
  IconMore,
  IconQr,
  type IconProps,
} from '@/src/components/icons';
import { Spinner } from '@/src/components/ui';
import Activity from '@/src/screens/Activity';
import Approve from '@/src/screens/Approve';
import Chat from '@/src/screens/Chat';
import Home from '@/src/screens/Home';
import Onboarding from '@/src/screens/Onboarding';
import Receive from '@/src/screens/Receive';
import Send from '@/src/screens/Send';
import Settings from '@/src/screens/Settings';
import Unlock from '@/src/screens/Unlock';

/** Вкладки нижньої навігації (доступні після розблокування). */
const TABS: { screen: Screen; label: string; icon: ComponentType<IconProps> }[] = [
  { screen: 'home', label: 'Головна', icon: IconHome },
  { screen: 'activity', label: 'Активність', icon: IconActivity },
  { screen: 'receive', label: 'Отримати', icon: IconQr },
  { screen: 'chat', label: 'Чат', icon: IconChat },
  { screen: 'settings', label: 'Ще', icon: IconMore },
];

/** Окреме вікно підтвердження підпису відкривається з ?view=approve. */
const isApproveView =
  new URLSearchParams(window.location.search).get('view') === 'approve';

export default function App() {
  const { hasWallet, unlocked, screen, setScreen, initialize } = useWalletStore();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Вікно підтвердження підпису — окремий потік, без навігації.
  // TODO: вимагати розблокування перед показом запиту.
  if (isApproveView) {
    return <Approve />;
  }

  if (hasWallet === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!hasWallet) return <Onboarding />;
  if (!unlocked) return <Unlock />;

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
        aria-label="Основна навігація"
        className="fixed inset-x-0 bottom-0 z-20 grid h-14 grid-cols-5 border-t border-hairline bg-bg/95 backdrop-blur-sm"
      >
        {TABS.map((tab) => {
          const active = screen === tab.screen;
          const Icon = tab.icon;
          return (
            <button
              key={tab.screen}
              type="button"
              onClick={() => setScreen(tab.screen)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium tracking-wide transition-colors ${
                active ? 'text-brass' : 'text-muted hover:text-ink'
              }`}
            >
              {/* Латунна риска над активною вкладкою */}
              <span
                className={`absolute -top-px left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-brass transition-opacity ${
                  active ? 'opacity-100' : 'opacity-0'
                }`}
              />
              <Icon size={19} />
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
