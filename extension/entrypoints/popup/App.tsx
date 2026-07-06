import { useEffect } from 'react';

import { useWalletStore, type Screen } from '@/src/store/wallet';
import { Spinner } from '@/src/components/ui';
import Activity from '@/src/screens/Activity';
import Approve from '@/src/screens/Approve';
import Chat from '@/src/screens/Chat';
import Home from '@/src/screens/Home';
import Onboarding from '@/src/screens/Onboarding';
import Send from '@/src/screens/Send';
import Unlock from '@/src/screens/Unlock';

/** Вкладки нижньої навігації (доступні після розблокування). */
const TABS: { screen: Screen; label: string; icon: string }[] = [
  { screen: 'home', label: 'Гаманець', icon: '◆' },
  { screen: 'send', label: 'Надіслати', icon: '↗' },
  { screen: 'activity', label: 'Активність', icon: '≡' },
  { screen: 'chat', label: 'AI-чат', icon: '✦' },
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
      case 'chat':
        return <Chat />;
      case 'approve':
        return <Approve />;
      case 'home':
      case 'onboarding':
      case 'unlock':
        return <Home />;
    }
  };

  return (
    <div className="flex min-h-[600px] flex-1 flex-col">
      <main className="flex flex-1 flex-col overflow-y-auto">{renderScreen()}</main>
      <nav className="grid grid-cols-4 border-t border-zinc-800/80 bg-zinc-950/95">
        {TABS.map((tab) => {
          const active = screen === tab.screen;
          return (
            <button
              key={tab.screen}
              type="button"
              onClick={() => setScreen(tab.screen)}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors ${
                active ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <span className="text-base leading-none">{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
