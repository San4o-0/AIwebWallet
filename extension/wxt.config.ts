import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// Конфігурація WXT (Manifest V3).
// Докладніше: https://wxt.dev/api/config.html

// ---------------------------------------------------------------------------
// Базовий URL бекенду — BUILD-TIME конфігурація (VITE_API_BASE_URL), а не
// константа в коді. Джерела: .env / .env.local / .env.{mode} / .env.{browser}
// (WXT вантажить їх у process.env ДО виклику manifest()/vite()) або змінна
// оточення CI. Дефолт для розробки — http://localhost:8080/v1.
//
// БЕЗПЕКА: у production-збірці cleartext (http://) заборонено ЖОРСТКО — збірка
// падає з помилкою, артефакт не створюється. Це надійніше за рантайм-warn:
// warn у консолі service worker ніхто не побачить, а зібраний .zip уже можна
// викласти в стор; помилка збірки фізично унеможливлює деплой із http.
// Причина: /v1/tx/params віддає chain_id, nonce і комісії, які потрапляють у
// RLP підписаної транзакції. По http MITM підмінює chain_id → валідний підпис
// у ЧУЖІЙ мережі (replay). (Клієнт додатково звіряє chain_id із локальною
// константою — verifyTxParams у src/lib/evm.ts, — але транспорт усе одно має
// бути шифрованим: адреси, баланси, комісії, історія.)
// ---------------------------------------------------------------------------

const DEFAULT_DEV_API_BASE_URL = 'http://localhost:8080/v1';

/**
 * Дефолт для production-збірки без VITE_API_BASE_URL. `.example` — зарезервований
 * TLD (RFC 2606): домен НЕ можна зареєструвати, тож збірка-«забудька» просто не
 * достукається до бекенду (fail-closed) і НІКОЛИ не піде по cleartext. Ключове:
 * дефолт прода ≠ дефолт дева, тому localhost-http фізично не може «поїхати» у
 * стор навіть випадково.
 */
const PLACEHOLDER_PROD_API_BASE_URL = 'https://api.argus.example/v1';

/** WXT викликає manifest()/vite() кілька разів — попереджаємо один раз. */
let warnedAboutPlaceholder = false;

/** Провалідований базовий URL API + host permission для маніфеста. */
function resolveApiBaseUrl(mode: string): { baseUrl: string; hostPermission: string } {
  const isProduction = mode === 'production';
  const configured = process.env.VITE_API_BASE_URL?.trim();
  if ((configured === undefined || configured === '') && isProduction && !warnedAboutPlaceholder) {
    warnedAboutPlaceholder = true;
    console.warn(
      [
        '',
        '[argus] УВАГА: production-збірка без VITE_API_BASE_URL.',
        `  Використано плейсхолдер ${PLACEHOLDER_PROD_API_BASE_URL} (домен .example не існує` +
          ' — розширення не достукається до бекенду).',
        '  Перед релізом зберіть із реальним https-URL:',
        '    VITE_API_BASE_URL=https://api.example.com/v1 pnpm build',
        '',
      ].join('\n'),
    );
  }
  const raw =
    configured !== undefined && configured !== ''
      ? configured
      : isProduction
        ? PLACEHOLDER_PROD_API_BASE_URL
        : DEFAULT_DEV_API_BASE_URL;
  const baseUrl = raw.replace(/\/+$/, '');

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(
      `[argus] VITE_API_BASE_URL="${raw}" не є абсолютним URL. Приклад: https://api.example.com/v1`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[argus] VITE_API_BASE_URL: непідтримувана схема "${url.protocol}".`);
  }

  // Прод + cleartext → збірка падає. Жодного «попередити і продовжити».
  if (isProduction && url.protocol !== 'https:') {
    throw new Error(
      [
        '',
        '[argus] ЗБІРКУ ЗУПИНЕНО: production-збірка з cleartext-бекендом.',
        `  VITE_API_BASE_URL = ${baseUrl}`,
        '',
        '  Бекенд віддає chain_id, nonce і комісії, які підписуються у складі',
        '  транзакції. По http:// їх підмінює будь-який MITM — підпис стає',
        '  валідним у чужій мережі (replay) або спалює баланс на комісії.',
        '',
        '  Виправлення: зберіть із https-URL, напр.',
        '    VITE_API_BASE_URL=https://api.example.com/v1 pnpm build',
        '  Для локальної розробки використовуйте `pnpm dev` (mode=development).',
        '',
      ].join('\n'),
    );
  }

  // host_permissions: origin бекенду — і тільки він. MV3 інакше блокує fetch
  // до стороннього origin із service worker; у Firefox-MV2 WXT сам перекладе
  // цей ключ у `permissions`.
  return { baseUrl, hostPermission: `${url.origin}/*` };
}

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser, mode }) => {
    const { hostPermission } = resolveApiBaseUrl(mode);
    return {
      name: 'Argus',
      // Англійська як мова маніфеста за замовчуванням (сторінка стора).
      // TODO(i18n): локалізувати name/description через chrome.i18n `_locales`
      // + `default_locale` (__MSG_*__), коли з'являться перекладені описи —
      // рантайм-i18n попапа цього механізму не потребує.
      description:
        'Argus — a non-custodial AI crypto wallet that explains every transaction, warns you before you sign, and analyzes your activity.',
      permissions: ['storage', 'alarms'],
      // Доступ до бекенду (і тільки до нього). Origin береться з тієї самої
      // build-time env, що й API_BASE_URL, — маніфест і код не розʼїдуться.
      host_permissions: [hostPermission],
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
    };
  },
  vite: ({ mode }) => {
    const { baseUrl } = resolveApiBaseUrl(mode);
    return {
      plugins: [tailwindcss()],
      // Вшиваємо ВЖЕ ПРОВАЛІДОВАНИЙ URL (включно з dev-дефолтом), щоб
      // src/lib/api.ts не залежав від наявності .env-файлу.
      define: {
        'import.meta.env.VITE_API_BASE_URL': JSON.stringify(baseUrl),
      },
      build: {
        // Не інлайнити wallet_core_bg.wasm base64-даними у бандли: бінарник
        // роздається з кореня розширення (public/), див. src/wasm/index.ts.
        assetsInlineLimit: 0,
      },
    };
  },
});
