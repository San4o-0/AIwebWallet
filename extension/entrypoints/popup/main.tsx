import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { i18n, initI18n } from '@/src/i18n';

import App from './App';
import './style.css';

// Глобальний лог помилок попапа: краші поза React-деревом (async-хендлери,
// проміси) не ловляться ErrorBoundary — принаймні фіксуємо їх у консолі,
// щоб чорний екран/тихий фейл можна було діагностувати в будь-якому браузері.
window.addEventListener('error', (event) => {
  console.error('[aiwallet] window.onerror:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[aiwallet] Unhandled rejection in popup:', event.reason);
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // РЕТРАЇ ЖИВУТЬ У ТРАНСПОРТІ, а не тут (src/lib/api.ts, `request()`):
      // до 3 спроб із бекофом 1 с → 2 с на транзієнтних збоях (таймаут, обрив
      // мережі, 502/503/504 від проксі, що будить приспаний інстанс). Так вони
      // працюють і в background — а там /tx/params і /tx/broadcast ідуть без
      // TanStack узагалі, — і так /tx/broadcast може лишитись єдиним
      // ендпоінтом БЕЗ повторів (він не ідемпотентний).
      //
      // Другий шар ретраїв тут лише перемножив би спроби (3 × 3 = 9) і розтягнув
      // найгірший випадок на хвилини, тому — false. Це не «ретраї вимкнено»:
      // це «ретраї рівно в одному місці».
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('#root element not found');
}
const root = ReactDOM.createRoot(rootElement);

// i18n ініціалізується ДО рендера: активна локаль (+ en fallback)
// підвантажується ліниво, тож перший кадр уже правильною мовою і без
// мерехтіння ключів. Помилка ініціалізації не блокує гаманець — рендеримо
// з fallback-ресурсами (i18next віддасть ключі/en, що краще за чорний екран).
void initI18n()
  .catch((error: unknown) => {
    console.error('[aiwallet] i18n initialization failed:', error);
  })
  .then(() => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={queryClient}>
              <App />
            </QueryClientProvider>
          </I18nextProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  });
