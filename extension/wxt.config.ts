import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// Конфігурація WXT (Manifest V3).
// Докладніше: https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'AI Wallet',
    description:
      'Non-custodial криптогаманець з AI-помічником: пояснення транзакцій, аналіз ризиків, чат.',
    permissions: ['storage', 'alarms'],
    // Явний ID для Firefox (about:debugging приймає і без нього, але для
    // підпису/оновлень addons.mozilla.org ID обов'язковий).
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'ai-wallet@aiwallet.dev',
              strict_min_version: '115.0',
            },
          },
        }
      : {}),
    // WASM-ядро (crates/wallet-core): MV3 вимагає 'wasm-unsafe-eval' для
    // WebAssembly.instantiate у extension pages та background service worker.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // injected.js інжектиться content-скриптом у контекст сторінки (EIP-1193 провайдер),
    // тому має бути доступним як web-accessible resource.
    web_accessible_resources: [
      {
        resources: ['injected.js'],
        matches: ['<all_urls>'],
      },
    ],
  }),
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Не інлайнити wallet_core_bg.wasm base64-даними у бандли: бінарник
      // роздається з кореня розширення (public/), див. src/wasm/index.ts.
      assetsInlineLimit: 0,
    },
  }),
});
