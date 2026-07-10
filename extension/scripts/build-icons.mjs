/**
 * Растеризація фірмової іконки розширення: assets/icon.svg → public/icon/{N}.png
 * для розмірів 16/32/48/96/128 (браузер бере їх для тулбар-кнопки та
 * about:addons; WXT копіює public/ у корінь .output/, а icons/action у
 * маніфесті вказують на icon/{N}.png — див. wxt.config.ts).
 *
 * Растеризатор: @resvg/resvg-js (нативний, точний рендер SVG). Якщо він не
 * встановився на цій платформі — fallback на sharp. Обидва — devDependency;
 * якщо жодного немає, скрипт падає з підказкою.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(extensionDir, 'assets', 'icon.svg');
const outDir = join(extensionDir, 'public', 'icon');

const SIZES = [16, 32, 48, 96, 128];

const svg = readFileSync(svgPath, 'utf8');
mkdirSync(outDir, { recursive: true });

/** @resvg/resvg-js: рендер конкретної ширини (fitTo width). */
async function renderWithResvg() {
  const { Resvg } = await import('@resvg/resvg-js');
  for (const size of SIZES) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0,0,0,0)',
    });
    const png = resvg.render().asPng();
    writeFileSync(join(outDir, `${size}.png`), png);
  }
  return 'resvg';
}

/** sharp: растеризує SVG-буфер у PNG заданого розміру. */
async function renderWithSharp() {
  const sharp = (await import('sharp')).default;
  const buf = Buffer.from(svg);
  for (const size of SIZES) {
    const png = await sharp(buf, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    writeFileSync(join(outDir, `${size}.png`), png);
  }
  return 'sharp';
}

let engine;
try {
  engine = await renderWithResvg();
} catch (resvgErr) {
  try {
    engine = await renderWithSharp();
  } catch (sharpErr) {
    console.error('[build-icons] Немає растеризатора. Встановіть один із:');
    console.error('  pnpm add -D @resvg/resvg-js   (основний)');
    console.error('  pnpm add -D sharp             (fallback)');
    console.error(`  resvg: ${resvgErr.message}`);
    console.error(`  sharp: ${sharpErr.message}`);
    process.exit(1);
  }
}

console.log(`[build-icons] Готово (${engine}): public/icon/{${SIZES.join(',')}}.png`);
