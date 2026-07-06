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
 * Ініціалізує WASM-модуль один раз на контекст (popup / service worker)
 * і повертає його експорти. Повторні виклики повертають той самий проміс.
 */
export function loadWalletCoreWasm(): Promise<WalletCoreWasm> {
  loading ??= initWasm({
    module_or_path: browser.runtime.getURL('/wallet_core_bg.wasm'),
  }).then(() => wasm);
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
