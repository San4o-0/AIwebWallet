/**
 * Збірка WASM-ядра: crates/wallet-core → src/wasm/pkg (wasm-pack, target web).
 *
 * Кроки:
 *  1. wasm-pack build (release, --no-opt: бандлений wasm-opt старіший за
 *     фічі wasm, які емітить актуальний rustc, і падає на валідації);
 *  2. патч згенерованого glue: прибираємо fallback
 *     `new URL('wallet_core_bg.wasm', import.meta.url)` — він мертвий код
 *     (init завжди отримує module_or_path), але WXT збирає background у
 *     lib-режимі Vite, де цей патерн інлайнить бінарник base64-даними у
 *     бандл (+880 КБ);
 *  3. копіюємо .wasm у public/ — WXT кладе його в корінь розширення, звідки
 *     його fetch-ить init у popup і background SW (див. src/wasm/index.ts).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(extensionDir, 'src', 'wasm', 'pkg');

// 1. wasm-pack (бінарник із devDependencies; node_modules/.bin у PATH через pnpm).
execFileSync(
  'wasm-pack',
  [
    'build',
    '../crates/wallet-core',
    '--release',
    '--no-opt',
    '--target',
    'web',
    '--out-dir',
    '../../extension/src/wasm/pkg',
    '--no-pack',
    '--',
    '--features',
    'wasm',
  ],
  { cwd: extensionDir, stdio: 'inherit' },
);

// 2. Патч glue-модуля: без import.meta.url-fallback.
const gluePath = join(pkgDir, 'wallet_core.js');
const glue = readFileSync(gluePath, 'utf8');
const fallback = "module_or_path = new URL('wallet_core_bg.wasm', import.meta.url);";
if (glue.includes(fallback)) {
  writeFileSync(
    gluePath,
    glue.replace(
      fallback,
      "throw new Error('wallet_core: init() вимагає module_or_path (див. src/wasm/index.ts)');",
    ),
  );
} else if (!glue.includes('init() вимагає module_or_path')) {
  console.warn('[build-wasm] УВАГА: fallback із import.meta.url не знайдено — перевірте glue.');
}

// 3. Копія бінарника у public/ (корінь зібраного розширення).
mkdirSync(join(extensionDir, 'public'), { recursive: true });
copyFileSync(
  join(pkgDir, 'wallet_core_bg.wasm'),
  join(extensionDir, 'public', 'wallet_core_bg.wasm'),
);
console.log('[build-wasm] Готово: src/wasm/pkg + public/wallet_core_bg.wasm');
