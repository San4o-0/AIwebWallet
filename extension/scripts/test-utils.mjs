/**
 * Спільні утиліти Node-тестів multi-vault сховища:
 *  - стаб browser.storage.local (in-memory, persist між import-ами модуля);
 *  - бандлінг src/lib/vault-storage.ts через esbuild з alias wxt/browser → стаб.
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
 * Збирає РЕАЛЬНИЙ production-код src/lib/vault-storage.ts у ESM-бандл із
 * підміненим wxt/browser і повертає фабрику свіжих інстансів модуля
 * (query-суфікс обходить кеш ESM — міграційний memo скидається, а стаб
 * storage персистить у globalThis, як справжній chrome.storage.local).
 */
export async function bundleVaultStorage() {
  const esbuild = resolveEsbuild();
  const outDir = await mkdtemp(join(tmpdir(), 'aiwallet-vault-test-'));
  const outfile = join(outDir, 'vault-storage.bundle.mjs');
  await esbuild.build({
    entryPoints: [join(extensionRoot, 'src/lib/vault-storage.ts')],
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

/** Мапа стабу storage (див. wxt-browser-stub.mjs). */
export function stubStorage() {
  return (globalThis.__aiwalletTestStorage ??= new Map());
}

export function resetStubStorage() {
  stubStorage().clear();
}
