#!/usr/bin/env node
/**
 * Перевірка локалей (pnpm check:locales):
 *   1) кожен src/locales/{locale}.json має РІВНО той самий набір ключів, що
 *      en.json (еталон): відсутні → помилка зі списком; зайві → помилка;
 *   2) плейсхолдери {{name}} у кожному рядку збігаються з en.json;
 *   3) імена файлів — лише локалі з реєстру (src/i18n/locales.ts);
 *   4) значення — непорожні рядки.
 *
 * Плюральні суфікси i18next (_zero/_one/_two/_few/_many/_other) нормалізуються
 * до базового ключа: набір форм ЛЕГІТИМНО різниться між мовами (CLDR),
 * але кожна форма мусить мати ті самі плейсхолдери, що en-форми цього ключа.
 *
 * en.notes.json (контекст для перекладачів) і README.md не перевіряються.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');

/** Реєстр локалей — тримати синхронним із src/i18n/locales.ts. */
const SUPPORTED_LOCALES = [
  'uk', 'en', 'zh-CN', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru',
  'ur', 'id', 'de', 'ja', 'tr', 'ko', 'vi', 'it', 'pl',
];

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Рекурсивно збирає листові ключі "a.b.c" → значення. */
function flatten(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** Базовий ключ без плюрального суфікса. */
const baseKey = (key) => key.replace(PLURAL_SUFFIX, '');

/** Набір плейсхолдерів {{name}} у рядку. */
function placeholders(value) {
  const found = new Set();
  for (const match of String(value).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(match[1]);
  return found;
}

const referencePath = join(localesDir, 'en.json');
const reference = flatten(JSON.parse(readFileSync(referencePath, 'utf8')));
const referenceBases = new Set([...reference.keys()].map(baseKey));
/** База → об'єднані плейсхолдери всіх en-форм (для плюралів). */
const referencePlaceholders = new Map();
for (const [key, value] of reference) {
  const base = baseKey(key);
  const set = referencePlaceholders.get(base) ?? new Set();
  for (const name of placeholders(value)) set.add(name);
  referencePlaceholders.set(base, set);
}

const files = readdirSync(localesDir)
  .filter((file) => file.endsWith('.json') && !file.endsWith('.notes.json'))
  .sort();

let failCount = 0;
const fail = (message) => {
  failCount += 1;
  console.error(`  ERROR ${message}`);
};

for (const file of files) {
  const failCountBefore = failCount;
  const locale = file.replace(/\.json$/, '');
  console.log(`— ${file}`);
  if (!SUPPORTED_LOCALES.includes(locale)) {
    fail(`локаль "${locale}" відсутня в реєстрі (src/i18n/locales.ts)`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
  } catch (error) {
    fail(`некоректний JSON: ${error.message}`);
    continue;
  }
  const flat = flatten(data);
  const bases = new Set([...flat.keys()].map(baseKey));

  const missing = [...referenceBases].filter((key) => !bases.has(key));
  const extra = [...bases].filter((key) => !referenceBases.has(key));
  if (missing.length > 0) fail(`відсутні ключі (${missing.length}):\n    ${missing.join('\n    ')}`);
  if (extra.length > 0) fail(`зайві ключі (${extra.length}):\n    ${extra.join('\n    ')}`);

  for (const [key, value] of flat) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`"${key}": значення має бути непорожнім рядком`);
      continue;
    }
    const base = baseKey(key);
    const expected = referencePlaceholders.get(base);
    if (expected === undefined) continue; // уже зловлено як "зайвий ключ"
    const actual = placeholders(value);
    const missingPh = [...expected].filter((name) => !actual.has(name));
    const extraPh = [...actual].filter((name) => !expected.has(name));
    // {{count}} у плюральних формах може бути відсутнім у частині форм
    // (напр. "one word" без числа) — не вважаємо це помилкою.
    const tolerable = (name) => name === 'count' && PLURAL_SUFFIX.test(key);
    for (const name of missingPh) {
      if (!tolerable(name)) fail(`"${key}": відсутній плейсхолдер {{${name}}} (є в en.json)`);
    }
    for (const name of extraPh) {
      fail(`"${key}": зайвий плейсхолдер {{${name}}} (немає в en.json)`);
    }
  }
  if (failCount === failCountBefore) console.log(`  ok: ${bases.size} ключів`);
}

if (files.length === 0) {
  console.error('ERROR: у src/locales немає жодного *.json');
  process.exit(1);
}
if (!files.includes('en.json')) {
  console.error('ERROR: відсутній еталон src/locales/en.json');
  process.exit(1);
}

if (failCount > 0) {
  console.error(`\ncheck-locales: FAILED (${failCount} помилок)`);
  process.exit(1);
}
console.log(`\ncheck-locales: OK (${files.length} локалей, еталон en.json: ${referenceBases.size} ключів)`);
