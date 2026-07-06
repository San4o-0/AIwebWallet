/**
 * Типобезпечна обгортка над browser.runtime.sendMessage.
 * Використовується з content script та popup (НЕ з injected — там немає chrome.*).
 */
import { browser } from 'wxt/browser';

import type { BackgroundMessage, BackgroundResponseMap } from './messaging';

export async function sendToBackground<M extends BackgroundMessage>(
  message: M,
): Promise<BackgroundResponseMap[M['type']]> {
  const response: unknown = await browser.runtime.sendMessage(message);
  // Відповідь формує наш background відповідно до BackgroundResponseMap.
  return response as BackgroundResponseMap[M['type']];
}
