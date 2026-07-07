/**
 * Лінивий завантажувач WASM-ядра (crates/wallet-core → wasm-pack, target web).
 *
 * Артефакти генеруються командою `pnpm build:wasm` у `src/wasm/pkg/` і не
 * комітяться (pkg/.gitignore від wasm-pack); бінарник додатково копіюється у
 * `public/wallet_core_bg.wasm`, звідки WXT кладе його в корінь розширення.
 *
 * Модуль працює і в popup (extension page), і в background service worker
 * MV3: init отримує chrome-extension:// URL і завантажує бінарник через
 * fetch + instantiateStreaming — `document` не потрібен. Навмисно НЕ
 * використовуємо Vite `?url`-імпорт: WXT збирає background у lib-режимі, де
 * Vite інлайнить ассети base64-даними у бандл (+880 КБ і подвійна пам'ять).
 * Для інстанціації WASM у MV3 маніфест мусить мати CSP `'wasm-unsafe-eval'`
 * (див. wxt.config.ts).
 */
import { browser } from 'wxt/browser';

import initWasm, * as wasm from './pkg/wallet_core';

/** Типізована поверхня wasm-bindgen експортів wallet-core. */
export type WalletCoreWasm = typeof wasm;

let loading: Promise<WalletCoreWasm> | null = null;

/**
 * Ініціалізація з fallback для Firefox: `WebAssembly.instantiateStreaming`
 * вимагає MIME `application/wasm`; для moz-extension:// ресурсів Firefox може
 * віддати Response, на якому streaming-інстанціація кидає TypeError (а
 * вбудований fallback wasm-bindgen спрацьовує не для всіх Response.type).
 * Тоді повторюємо через fetch → arrayBuffer → WebAssembly.instantiate.
 */
async function initialize(): Promise<WalletCoreWasm> {
  const url = browser.runtime.getURL('/wallet_core_bg.wasm');
  try {
    await initWasm({ module_or_path: url });
  } catch (streamingError) {
    console.warn(
      '[aiwallet] instantiateStreaming не вдалась, fallback на ArrayBuffer:',
      streamingError,
    );
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Не вдалося завантажити WASM-ядро: HTTP ${response.status}`);
    await initWasm({ module_or_path: await response.arrayBuffer() });
  }
  return wasm;
}

/**
 * Ініціалізує WASM-модуль один раз на контекст (popup / background)
 * і повертає його експорти. Повторні виклики повертають той самий проміс;
 * невдала спроба НЕ кешується — наступний виклик пробує знову.
 */
export function loadWalletCoreWasm(): Promise<WalletCoreWasm> {
  loading ??= initialize().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * wasm-bindgen кидає помилки як `JsValue::from_str` → у JS прилітає string,
 * а не Error. Нормалізуємо до Error з читабельним повідомленням.
 */
export function toWasmError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(String(error));
}
