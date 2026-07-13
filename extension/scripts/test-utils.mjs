/**
 * Спільні утиліти Node-тестів (multi-vault сховище, дозволи по origin):
 *  - стаб browser.storage.local (in-memory, persist між import-ами модуля);
 *  - бандлінг РЕАЛЬНИХ модулів src/lib/*.ts через esbuild з alias
 *    wxt/browser → стаб.
 *
 * esbuild не є прямою залежністю — резолвиться через ланцюжок wxt → vite →
 * esbuild (pnpm ховає транзитивні пакети з кореня node_modules).
 */
import { realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));

function resolveEsbuild() {
  const wxtEntry = realpathSync(join(extensionRoot, 'node_modules/wxt/dist/index.mjs'));
  const viteEntry = realpathSync(createRequire(wxtEntry).resolve('vite'));
  return createRequire(viteEntry)('esbuild');
}

/**
 * Збирає РЕАЛЬНИЙ production-код модуля розширення (src/lib/*.ts) у ESM-бандл
 * із підміненим wxt/browser і повертає фабрику свіжих інстансів модуля
 * (query-суфікс обходить кеш ESM — модульні memo скидаються, а стаб storage
 * персистить у globalThis, як справжній chrome.storage.local).
 *
 * @param {string} entry шлях від кореня extension/, напр. 'src/lib/connections.ts'
 */
export async function bundleModule(entry) {
  const esbuild = resolveEsbuild();
  const outDir = await mkdtemp(join(tmpdir(), 'aiwallet-test-'));
  const outfile = join(outDir, 'module.bundle.mjs');
  await esbuild.build({
    entryPoints: [join(extensionRoot, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    alias: { 'wxt/browser': fileURLToPath(new URL('./wxt-browser-stub.mjs', import.meta.url)) },
    logLevel: 'silent',
  });
  let generation = 0;
  return {
    /** Свіжий інстанс модуля (новий контекст ≈ рестарт service worker). */
    freshModule: () => import(`${pathToFileURL(outfile).href}?g=${++generation}`),
  };
}

/** Бандл сховища гаманців (сумісність із наявними тестами). */
export function bundleVaultStorage() {
  return bundleModule('src/lib/vault-storage.ts');
}

/** Мапа стабу storage (див. wxt-browser-stub.mjs). */
export function stubStorage() {
  return (globalThis.__aiwalletTestStorage ??= new Map());
}

export function resetStubStorage() {
  stubStorage().clear();
}
