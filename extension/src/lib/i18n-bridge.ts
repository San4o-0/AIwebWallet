/**
 * Місток до i18n для СПІЛЬНИХ модулів (api.ts, mock-data.ts), які бандляться
 * і в background service worker. Вони НЕ можуть імпортувати i18next напряму:
 * ядро i18n використовує import.meta.glob (динамічні імпорти локалей), що
 * несумісно з одно-файловим бандлом background MV3, і тягне зайву вагу.
 *
 * Попап під час initI18n() біндить сюди справжні t()/локаль; у background
 * місток лишається незабіндженим — там перекладені рядки не рендеряться
 * (мок-фолбеки і lang-поля використовуються лише в попапі).
 */

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

let translateFn: TranslateFn = (key) => key;
let localeFn: () => string = () => 'en';

/** Викликається з ядра i18n (попап) після ініціалізації i18next. */
export function bindSharedI18n(translate: TranslateFn, getLocale: () => string): void {
  translateFn = translate;
  localeFn = getLocale;
}

/** t() для спільних модулів; до біндингу повертає ключ як є. */
export function sharedT(key: string, params?: Record<string, unknown>): string {
  return translateFn(key, params);
}

/** Активна локаль для бекенд-запитів (lang); до біндингу — 'en'. */
export function sharedLocale(): string {
  return localeFn();
}
