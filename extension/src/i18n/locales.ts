/**
 * Реєстр локалей глобальної локалізації (19 мов, ТЗ i18n).
 *
 * Додавання нової мови = додати JSON у src/locales/{locale}.json — реєстр уже
 * містить усі цільові локалі, тож селектор у Settings показує їх одразу;
 * поки JSON-а немає, i18next рендерить en-fallback.
 */

export const SUPPORTED_LOCALES = [
  'uk',
  'en',
  'zh-CN',
  'hi',
  'es',
  'fr',
  'ar',
  'bn',
  'pt',
  'ru',
  'ur',
  'id',
  'de',
  'ja',
  'tr',
  'ko',
  'vi',
  'it',
  'pl',
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Мови з письмом справа наліво: корінь попапа отримує dir="rtl". */
export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar', 'ur']);

/** Назви мов У ЇХНІЙ мові — для селектора в Settings (не перекладаються). */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  uk: 'Українська',
  en: 'English',
  'zh-CN': '中文',
  hi: 'हिन्दी',
  es: 'Español',
  fr: 'Français',
  ar: 'العربية',
  bn: 'বাংলা',
  pt: 'Português',
  ru: 'Русский',
  ur: 'اردو',
  id: 'Bahasa Indonesia',
  de: 'Deutsch',
  ja: '日本語',
  tr: 'Türkçe',
  ko: '한국어',
  vi: 'Tiếng Việt',
  it: 'Italiano',
  pl: 'Polski',
};

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isRtl(locale: string): boolean {
  return isSupportedLocale(locale) && RTL_LOCALES.has(locale);
}

/**
 * Нормалізація BCP-47 тега браузера до локалі реєстру:
 *   en-US → en, pt-BR → pt, zh / zh-TW / zh-Hans → zh-CN;
 *   немає в реєстрі → en (глобальний fallback).
 */
export function normalizeLocale(raw: string | null | undefined): Locale {
  if (typeof raw !== 'string' || raw.length === 0) return 'en';
  const tag = raw.trim().replace(/_/g, '-');
  const lower = tag.toLowerCase();

  // Точний збіг (без урахування регістру): zh-cn → zh-CN.
  for (const locale of SUPPORTED_LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
  }
  // Уся китайська сім'я мапиться на єдину наявну zh-CN.
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN';
  // Базова мова тега: en-GB → en, pt-BR → pt, es-419 → es …
  const base = lower.split('-')[0] ?? '';
  if (isSupportedLocale(base)) return base;
  return 'en';
}
