/**
 * Ядро i18n (i18next БЕЗ react-залежностей — модуль безпечно імпортувати
 * і з не-React коду: src/lib/*, store; React-обв'язка — через
 * I18nextProvider у entrypoints/popup/main.tsx).
 *
 * Принципи:
 *  - локалі — JSON у src/locales/{locale}.json; завантажуються ЛІНИВО через
 *    import.meta.glob → у стартовий бандл не потрапляє жодна локаль, у
 *    рантаймі підвантажуються лише активна мова + en (fallback);
 *  - детекція: збережений ручний вибір (storage.local `aiwallet:locale`) →
 *    browser.i18n.getUILanguage() → navigator.language → normalizeLocale → en;
 *  - RTL: для ar/ur корінь документа отримує dir="rtl" (+ lang завжди);
 *  - помилки з background/shared-модулів приходять як i18n-ключі
 *    (`errors.…` або `key|{"param":…}`) — localizeError перекладає їх у попапі.
 */
import i18next from 'i18next';
import type { BackendModule, ReadCallback, ResourceKey } from 'i18next';
import { browser } from 'wxt/browser';

import { bindSharedI18n } from '../lib/i18n-bridge';
import { isRtl, isSupportedLocale, normalizeLocale, type Locale } from './locales';

export { LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, isRtl, normalizeLocale } from './locales';
export type { Locale } from './locales';

/** Ключ ручного вибору мови у storage.local (пріоритетніший за браузер). */
export const LOCALE_STORAGE_KEY = 'aiwallet:locale';

export const i18n = i18next;

/**
 * Ліниві завантажувачі локалей: Vite перетворює glob на мапу динамічних
 * import-ів (окремий чанк на кожен JSON). Додали src/locales/xx.json —
 * мова автоматично стала завантажуваною, коду не треба.
 */
const localeModules = import.meta.glob<{ default: ResourceKey }>([
  '../locales/*.json',
  // Контекст для перекладачів — не рантайм-ресурс.
  '!../locales/*.notes.json',
]);

function localeLoader(locale: string): (() => Promise<{ default: ResourceKey }>) | null {
  return localeModules[`../locales/${locale}.json`] ?? null;
}

/** Локалі, для яких уже існує JSON-файл (для діагностики/тестів). */
export function availableLocaleFiles(): string[] {
  return Object.keys(localeModules)
    .map((path) => path.replace('../locales/', '').replace('.json', ''))
    .sort();
}

const lazyBackend: BackendModule = {
  type: 'backend',
  init() {
    /* конфігурація не потрібна */
  },
  read(language: string, _namespace: string, callback: ReadCallback) {
    const loader = localeLoader(language);
    if (loader === null) {
      // Файлу мови ще немає — i18next піде у fallbackLng (en).
      callback(new Error(`No locale file for "${language}"`), false);
      return;
    }
    loader().then(
      (module) => callback(null, module.default),
      (error: unknown) => callback(error as Error, false),
    );
  },
};

/** Зчитує збережений ручний вибір мови; null — вибору не було. */
async function readStoredLocale(): Promise<Locale | null> {
  try {
    const items = await browser.storage.local.get(LOCALE_STORAGE_KEY);
    const stored = items[LOCALE_STORAGE_KEY];
    if (typeof stored === 'string' && isSupportedLocale(stored)) return stored;
  } catch {
    /* storage недоступний (тест/сторінка) — падаємо на детекцію браузера */
  }
  return null;
}

/** Мова UI браузера: browser.i18n → navigator.language. */
function browserUiLanguage(): string {
  try {
    const ui = browser.i18n?.getUILanguage?.();
    if (typeof ui === 'string' && ui.length > 0) return ui;
  } catch {
    /* API недоступне поза розширенням */
  }
  return typeof navigator !== 'undefined' ? navigator.language : '';
}

/** Активна локаль: ручний вибір → мова браузера → en. */
export async function detectLocale(): Promise<Locale> {
  const stored = await readStoredLocale();
  if (stored !== null) return stored;
  return normalizeLocale(browserUiLanguage());
}

/** dir/lang на корені документа (RTL: ar, ur). */
function applyDocumentDirection(locale: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr';
}

let initPromise: Promise<void> | null = null;

/**
 * Ініціалізація i18n (викликається один раз перед рендером попапа).
 * Повторні виклики повертають той самий проміс.
 */
export function initI18n(): Promise<void> {
  initPromise ??= (async () => {
    const locale = await detectLocale();
    await i18next.use(lazyBackend).init({
      lng: locale,
      fallbackLng: 'en',
      // 'currentOnly': не намагатися вантажити базові теги (zh для zh-CN).
      load: 'currentOnly',
      defaultNS: 'translation',
      interpolation: { escapeValue: false }, // React сам екранує
      returnNull: false,
      // Ключі без перекладу в мові → en (fallbackLng), тому нова мова може
      // з'являтися частково перекладеною.
      partialBundledLanguages: false,
    });
    applyDocumentDirection(locale);
    i18next.on('languageChanged', applyDocumentDirection);
    // Спільні модулі (api.ts, mock-data.ts) не імпортують i18next напряму —
    // біндимо їм t() і активну локаль через легкий місток.
    bindSharedI18n(
      (key, params) => i18next.t(key, params),
      () => getActiveLocale(),
    );
  })();
  return initPromise;
}

/** Активна локаль для бекенд-запитів (lang у /v1/tx/explain, /v1/chat). */
export function getActiveLocale(): Locale {
  if (i18next.isInitialized) return normalizeLocale(i18next.language);
  return 'en';
}

/**
 * Ручна зміна мови: зберігається у storage.local (пріоритет над браузером
 * назавжди, поки користувач не змінить знову) і застосовується одразу.
 */
export async function setLocale(locale: Locale): Promise<void> {
  try {
    await browser.storage.local.set({ [LOCALE_STORAGE_KEY]: locale });
  } catch (error) {
    console.warn('[aiwallet] Failed to persist locale choice:', error);
  }
  await i18next.changeLanguage(locale);
}

// ---------------------------------------------------------------------------
// Помилки як i18n-ключі
// ---------------------------------------------------------------------------

/**
 * Wire-формат помилок зі спільних модулів (evm.ts, vault-storage.ts,
 * background): `errors.some.key` або `errors.some.key|{"param":"value"}`.
 * Модулі, що бандляться у background/injected, НЕ імпортують i18n — вони
 * кидають ключ, а попап перекладає його тут.
 */
export function packError(key: string, params?: Record<string, string | number>): string {
  return params === undefined ? key : `${key}|${JSON.stringify(params)}`;
}

/**
 * Перекладає повідомлення-ключ; невідомий рядок (наприклад, текст від
 * бекенд-API або нативна помилка) повертається як є.
 */
export function localizeError(message: string): string {
  const separator = message.indexOf('|');
  const key = separator === -1 ? message : message.slice(0, separator);
  if (!key.startsWith('errors.') || !i18next.exists(key)) return message;
  let params: Record<string, unknown> = {};
  if (separator !== -1) {
    try {
      params = JSON.parse(message.slice(separator + 1)) as Record<string, unknown>;
    } catch {
      /* пошкоджені параметри — перекладаємо без них */
    }
  }
  // Параметри самі можуть бути запакованими ключами (вкладена помилка).
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string') params[name] = localizeError(value);
  }
  return i18next.t(key, params);
}

/** Локалізує unknown-помилку для UI: Error/string → текст, ключі → переклад. */
export function localizeUnknownError(error: unknown, fallbackKey: string): string {
  if (error instanceof Error) return localizeError(error.message);
  if (typeof error === 'string') return localizeError(error);
  return i18next.t(fallbackKey);
}
