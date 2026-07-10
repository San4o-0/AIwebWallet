import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// Конфігурація WXT (Manifest V3).
// Докладніше: https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Argus',
    // Англійська як мова маніфеста за замовчуванням (сторінка стора).
    // TODO(i18n): локалізувати name/description через chrome.i18n `_locales`
    // + `default_locale` (__MSG_*__), коли з'являться перекладені описи —
    // рантайм-i18n попапа цього механізму не потребує.
    description:
      'Argus — a non-custodial AI crypto wallet that explains every transaction, warns you before you sign, and analyzes your activity.',
    permissions: ['storage', 'alarms'],
    // Фірмова іконка розширення (генерується scripts/build-icons.mjs у
    // public/icon/{N}.png; WXT копіює public/ у корінь .output).
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    },
    // Іконка тулбар-кнопки. WXT нормалізує `action` під MV3 і під
    // Firefox-MV2 (browser_action) автоматично.
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        96: 'icon/96.png',
        128: 'icon/128.png',
      },
    },
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
