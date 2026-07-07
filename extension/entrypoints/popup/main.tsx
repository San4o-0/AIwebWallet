import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { ErrorBoundary } from '@/src/components/ErrorBoundary';

import App from './App';
import './style.css';

// Глобальний лог помилок попапа: краші поза React-деревом (async-хендлери,
// проміси) не ловляться ErrorBoundary — принаймні фіксуємо їх у консолі,
// щоб чорний екран/тихий фейл можна було діагностувати в будь-якому браузері.
window.addEventListener('error', (event) => {
  console.error('[aiwallet] window.onerror:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[aiwallet] Необроблений reject у попапі:', event.reason);
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Не знайдено #root');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
