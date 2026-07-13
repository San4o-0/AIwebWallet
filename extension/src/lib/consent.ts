/**
 * Згода на передачу даних (Chrome Web Store: розкриття + ЯВНА згода в UI
 * розширення ДО першої передачі; Firefox: browser_specific_settings.gecko.
 * data_collection_permissions у маніфесті, див. wxt.config.ts).
 *
 * Джерело правди про потоки даних — docs/PRIVACY.md:
 *  - НА НАШ БЕКЕНД (required, категорія Mozilla `financialAndPaymentInfo`):
 *    публічні адреси (баланси/історія/аналітика), деталі непідписаних
 *    транзакцій (ризик/симуляція/пояснення), підписані транзакції (broadcast),
 *    IP (rate-limiting);
 *  - AI-ПРОВАЙДЕРУ (optional, `personalCommunications`): деталі транзакцій для
 *    пояснень і зміст AI-чату. За замовчуванням ВИМКНЕНО (opt-in).
 *  - НЕ ЛИШАЄ ПРИСТРІЙ НІКОЛИ: seed, ключі, пароль, список підключених сайтів,
 *    мова — цей модуль їх не стосується взагалі.
 *
 * ЦЕЙ МОДУЛЬ — ЄДИНИЙ ГЕЙТ. src/lib/api.ts викликає assertNetworkConsent() у
 * `request()` (одна точка на всі ендпоінти) і assertAiConsent() там, де дані
 * йдуть AI-провайдеру. Доки згоди немає — жоден fetch не стартує (перевірка
 * стоїть ПЕРЕД fetch, а не після), тож «перша передача» фізично неможлива.
 *
 * Модуль бандлиться і в background (broadcast/tx-params ідуть звідти), тому:
 * без React, без i18next — помилки кидаються i18n-КЛЮЧАМИ (localizeError їх
 * перекладає в попапі).
 */
import { browser } from 'wxt/browser';

/** Запис згоди у chrome.storage.local. */
export const CONSENT_STORAGE_KEY = 'argus:dataConsent';

/**
 * Версія розкриття даних. ЗБІЛЬШИТИ, якщо змінився склад даних, що йдуть із
 * пристрою, або перелік отримувачів (docs/PRIVACY.md §2–3): стара згода стає
 * недійсною → екран згоди показується знову ДО наступного запиту.
 */
export const CONSENT_VERSION = 1;

/**
 * Політика конфіденційності (посилання з екрана згоди й Налаштувань).
 * TODO(release): замінити на реальний URL опублікованої docs/PRIVACY.md —
 * обидва стори вимагають робоче посилання в лістингу і в самому розширенні.
 */
export const PRIVACY_POLICY_URL = 'https://argus.example/privacy';

export interface DataConsent {
  /** CONSENT_VERSION на момент рішення. */
  version: number;
  /** ISO-час рішення. */
  decidedAt: string;
  /**
   * Обов'язковий обсяг: передача публічних адрес і транзакційних даних на
   * бекенд Argus. false — офлайн-режим (гаманець працює, мережевих функцій
   * немає): користувач має право відмовитись і все одно дістатись seed-фрази.
   */
  network: boolean;
  /** Опційний обсяг: AI-пояснення і чат (дані йдуть AI-провайдеру). */
  ai: boolean;
}

/** Рішення користувача на екрані згоди. */
export interface ConsentChoice {
  network: boolean;
  ai: boolean;
}

/** i18n-ключі відмов гейта (перекладаються в попапі через localizeError). */
export const CONSENT_DENIED_ERROR = 'errors.consent.networkDenied';
export const AI_DISABLED_ERROR = 'errors.consent.aiDisabled';

/**
 * Кеш у пам'яті контексту (попап/SW). Інвалідація — storage.onChanged, тож
 * зміна тумблера в попапі одразу діє і в background.
 * `undefined` — ще не читали; `null` — рішення немає.
 */
let cached: DataConsent | null | undefined;
let inflight: Promise<DataConsent | null> | null = null;

/** Валідатор запису: чужа/пошкоджена/стара форма → рішення немає (fail-closed). */
function parseConsent(raw: unknown): DataConsent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Partial<DataConsent>;
  if (value.version !== CONSENT_VERSION) return null; // політика змінилась — питаємо знову
  if (typeof value.network !== 'boolean' || typeof value.ai !== 'boolean') return null;
  return {
    version: CONSENT_VERSION,
    decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : '',
    network: value.network,
    ai: value.ai,
  };
}

/** Поточне рішення (null — його немає / воно застаріло). */
export async function readConsent(): Promise<DataConsent | null> {
  if (cached !== undefined) return cached;
  inflight ??= (async () => {
    try {
      const items = await browser.storage.local.get(CONSENT_STORAGE_KEY);
      cached = parseConsent(items[CONSENT_STORAGE_KEY]);
    } catch (error) {
      // Storage недоступний → поводимось так, ніби згоди немає: краще не
      // показати баланс, ніж мовчки передати адреси без згоди.
      console.error('[argus] Не вдалося прочитати згоду на передачу даних:', error);
      cached = null;
    } finally {
      inflight = null;
    }
    return cached;
  })();
  return inflight;
}

/** Записує рішення користувача (екран згоди / тумблери в Налаштуваннях). */
export async function saveConsent(choice: ConsentChoice): Promise<DataConsent> {
  const record: DataConsent = {
    version: CONSENT_VERSION,
    decidedAt: new Date().toISOString(),
    network: choice.network,
    // AI без передачі даних на бекенд неможливий: чат і пояснення йдуть ЧЕРЕЗ
    // наш бекенд. Не даємо зберегти суперечливий стан.
    ai: choice.network && choice.ai,
  };
  await browser.storage.local.set({ [CONSENT_STORAGE_KEY]: record });
  cached = record;
  notify();
  return record;
}

/** Перемикач «AI-функції» (Налаштування). Без згоди на мережу — no-op. */
export async function setAiEnabled(enabled: boolean): Promise<DataConsent | null> {
  const current = await readConsent();
  if (current === null) return null;
  return saveConsent({ network: current.network, ai: enabled });
}

/** Перемикач «Передача даних» (Налаштування). Вимкнення гасить і AI. */
export async function setNetworkEnabled(enabled: boolean): Promise<DataConsent | null> {
  const current = await readConsent();
  if (current === null) return null;
  return saveConsent({ network: enabled, ai: enabled && current.ai });
}

/** Чи дозволено взагалі звертатись до бекенду. */
export async function isNetworkAllowed(): Promise<boolean> {
  return (await readConsent())?.network === true;
}

/** Чи дозволено передавати дані AI-провайдеру (через наш бекенд). */
export async function isAiAllowed(): Promise<boolean> {
  const consent = await readConsent();
  return consent !== null && consent.network && consent.ai;
}

/**
 * ГЕЙТ №1: жодного мережевого запиту без згоди. Викликається в api.ts у
 * `request()` ПЕРЕД fetch — саме це й означає «до першої передачі».
 */
export async function assertNetworkConsent(): Promise<void> {
  if (!(await isNetworkAllowed())) throw new Error(CONSENT_DENIED_ERROR);
}

/** ГЕЙТ №2: /v1/chat і /v1/tx/explain — лише з увімкненими AI-функціями. */
export async function assertAiConsent(): Promise<void> {
  if (!(await isAiAllowed())) throw new Error(AI_DISABLED_ERROR);
}

// ---------------------------------------------------------------------------
// Реактивність: попап (React) підписується, background — інвалідує кеш.
// ---------------------------------------------------------------------------

type Listener = (consent: DataConsent | null) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener(cached ?? null);
}

/** Підписка на зміну рішення (повертає відписку). */
export function subscribeConsent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Скидає кеш (тести; зміна storage з іншого контексту). */
export function resetConsentCache(): void {
  cached = undefined;
  inflight = null;
}

// Зміна з іншого контексту (попап ↔ background): кеш більше не дійсний.
try {
  browser.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !(CONSENT_STORAGE_KEY in changes)) return;
    cached = parseConsent(changes[CONSENT_STORAGE_KEY]?.newValue);
    notify();
  });
} catch {
  /* storage.onChanged недоступний (тестовий стаб) — кеш живе в межах контексту */
}
