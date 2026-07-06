import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// Конфігурація WXT (Manifest V3).
// Докладніше: https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AI Wallet',
    description:
      'Non-custodial криптогаманець з AI-помічником: пояснення транзакцій, аналіз ризиків, чат.',
    permissions: ['storage', 'alarms'],
    // injected.js інжектиться content-скриптом у контекст сторінки (EIP-1193 провайдер),
    // тому має бути доступним як web-accessible resource.
    web_accessible_resources: [
      {
        resources: ['injected.js'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
