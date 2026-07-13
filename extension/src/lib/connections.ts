/**
 * Модель дозволів по origin («підключені сайти»).
 *
 * ПРОБЛЕМА, ЯКУ ЦЕ ЗАКРИВАЄ: без цього списку `eth_accounts` віддавав адресу
 * БУДЬ-ЯКОМУ сайту з відкритої вкладки (`window.ethereum.request({method:
 * 'eth_accounts'})`) — миттєва деанонімізація і матеріал для таргетованого
 * фішингу. MetaMask у цій ситуації повертає `[]`, і тепер Argus теж.
 *
 * Модель:
 *  - `argus:connectedSites` у chrome.storage.local — масив ConnectedSite;
 *  - origin потрапляє сюди ЛИШЕ після явного Approve на `eth_requestAccounts`;
 *  - `eth_accounts` віддає адресу тільки підключеним origin і тільки коли
 *    гаманець розблоковано; решті — `[]`;
 *  - `eth_sendTransaction` / `personal_sign` від непідключеного origin —
 *    4100 Unauthorized (dApp має спершу викликати eth_requestAccounts);
 *  - ревокація — з екрана «Підключені сайти» (Settings → Ще).
 *
 * Зберігаються тільки ПУБЛІЧНІ дані (origin, час, id/адреса гаманця на момент
 * підключення) — жодних секретів. Дозвіл прив'язаний до origin (як у MetaMask,
 * site-level), а не до конкретного акаунта: після перемикання гаманця
 * підключений сайт бачить адресу активної сесії, і запис оновлюється.
 */
import { browser } from 'wxt/browser';

import type { ConnectedSite } from './messaging';

export type { ConnectedSite } from './messaging';

const CONNECTED_SITES_KEY = 'argus:connectedSites';

function isConnectedSite(value: unknown): value is ConnectedSite {
  if (typeof value !== 'object' || value === null) return false;
  const site = value as Record<string, unknown>;
  return typeof site['origin'] === 'string' && typeof site['connectedAt'] === 'number';
}

/**
 * Нормалізація origin: усе порівняння дозволів іде через неї, щоб
 * `https://Site.com/` і `https://site.com` не стали різними дозволами.
 * Повертає null для того, що не є придатним web-origin (напр. `null` від
 * sandboxed-iframe, file://, opaque origin) — такий origin НІКОЛИ не
 * вважається підключеним.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

async function readSites(): Promise<ConnectedSite[]> {
  const stored = await browser.storage.local.get(CONNECTED_SITES_KEY);
  const raw: unknown = stored[CONNECTED_SITES_KEY];
  return Array.isArray(raw) ? raw.filter(isConnectedSite) : [];
}

async function writeSites(sites: ConnectedSite[]): Promise<void> {
  await browser.storage.local.set({ [CONNECTED_SITES_KEY]: sites });
}

/** Усі підключені сайти, найновіші зверху (для екрана «Підключені сайти»). */
export async function listConnectedSites(): Promise<ConnectedSite[]> {
  const sites = await readSites();
  return [...sites].sort((a, b) => b.connectedAt - a.connectedAt);
}

/** Чи схвалив користувач цей origin (не залежить від стану локу). */
export async function isOriginConnected(origin: string): Promise<boolean> {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  return (await readSites()).some((site) => site.origin === normalized);
}

/**
 * Записує origin як підключений (викликається ЛИШЕ після явного Approve
 * користувача на eth_requestAccounts). Повторне підключення оновлює гаманець/
 * адресу, але зберігає початковий `connectedAt` — щоб на екрані було видно,
 * відколи сайт має доступ.
 */
export async function addConnectedSite(
  origin: string,
  wallet: { walletId: string | null; accountAddress: string | null },
): Promise<void> {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return;
  const sites = await readSites();
  const existing = sites.find((site) => site.origin === normalized);
  const updated: ConnectedSite = {
    origin: normalized,
    connectedAt: existing?.connectedAt ?? Date.now(),
    walletId: wallet.walletId,
    accountAddress: wallet.accountAddress,
  };
  await writeSites([...sites.filter((site) => site.origin !== normalized), updated]);
}

/** Ревокація доступу одного сайту. */
export async function removeConnectedSite(origin: string): Promise<void> {
  const normalized = normalizeOrigin(origin) ?? origin;
  const sites = await readSites();
  await writeSites(sites.filter((site) => site.origin !== normalized));
}

/** Ревокація доступу всіх сайтів («Відключити всі»). */
export async function removeAllConnectedSites(): Promise<void> {
  await browser.storage.local.remove(CONNECTED_SITES_KEY);
}
