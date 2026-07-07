# Локалі AI Wallet / AI Wallet locales

## For translator agents (how to add a language)

1. **Reference (source of truth): `en.json`.** Translate from English; `uk.json`
   is the original authoring language if you need a second reference.
2. **Context for every key: `en.notes.json`** — where the string appears
   (button / title / aria-label / placeholder), placeholders, and length limits.
   The popup is only ~360–400 px wide: keep buttons and nav labels short.
3. **Create one file: `src/locales/{locale}.json`** with the exact key
   structure of `en.json`. The locale must be one of the registry codes in
   `src/i18n/locales.ts` (uk, en, zh-CN, hi, es, fr, ar, bn, pt, ru, ur, id,
   de, ja, tr, ko, vi, it, pl). Nothing else is needed — the file is picked up
   automatically (lazy `import.meta.glob`), the Settings selector already
   lists all 19 languages.
4. **Rules**
   - Keep `{{placeholders}}` verbatim (names must match en.json exactly).
   - Keep technical/brand terms untranslated: Argon2id, AES-256-GCM, BIP-39,
     EIP-1559, PSBT, BDK, EVM, ERC-20, seed (where noted), MoonPay, Uniswap…
   - Plural keys use i18next suffixes (`_one`, `_few`, `_many`, `_other`):
     provide the forms **your** language needs (CLDR plural rules); the set of
     suffixes may legitimately differ from en.json.
   - `approve.confirmPhrase` is typed by the user to confirm high-risk
     signatures — make it short and easy to type, no quotes inside.
   - RTL languages (ar, ur) need no special markup — direction is applied
     automatically from the registry.
5. **Verify:** `pnpm check:locales` (in `extension/`) — checks that your file
   has exactly the en.json key set and matching `{{placeholders}}`.

## Runtime behaviour

- Language detection: manual choice in `storage.local` (`aiwallet:locale`) →
  `browser.i18n.getUILanguage()` → `navigator.language` → normalization
  (`en-US`→`en`, `pt-BR`→`pt`, `zh*`→`zh-CN`) → `en` fallback.
- Locales load lazily (dynamic import): only the active language + `en`
  (fallback) are fetched at runtime.
- A language listed in the registry but without a JSON file renders fully in
  English until its file lands.
