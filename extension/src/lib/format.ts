/**
 * Хелпери форматування для UI: суми та відносний час — через Intl з АКТИВНОЮ
 * локаллю i18n (формат чисел/дат слідує за мовою інтерфейсу).
 *
 * Крипто-суми (raw amount токенів, адреси, tx-хеші) НЕ локалізуються —
 * це дані адресного рівня, вони завжди з крапкою і повною точністю.
 */
import { getActiveLocale, i18n } from '@/src/i18n';

/** Кеш форматерів на локаль (створення Intl.* відносно дороге). */
const usdFormatters = new Map<string, Intl.NumberFormat>();
const rtfFormatters = new Map<string, Intl.RelativeTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function usdFormatter(): Intl.NumberFormat {
  const locale = getActiveLocale();
  let formatter = usdFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    });
    usdFormatters.set(locale, formatter);
  }
  return formatter;
}

export function formatUsd(value: number): string {
  return usdFormatter().format(value);
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

function relativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = getActiveLocale();
  let formatter = rtfFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
    rtfFormatters.set(locale, formatter);
  }
  return formatter;
}

export function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return i18n.t('time.justNow');
  const rtf = relativeTimeFormatter();
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  return rtf.format(-days, 'day');
}

function dateTimeFormatter(): Intl.DateTimeFormat {
  const locale = getActiveLocale();
  let formatter = dateTimeFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    dateTimeFormatters.set(locale, formatter);
  }
  return formatter;
}

/** Абсолютна дата й час (unix ms) активною локаллю — для детального перегляду tx. */
export function formatDateTime(timestamp: number): string {
  return dateTimeFormatter().format(timestamp);
}
