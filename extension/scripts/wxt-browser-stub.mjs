/**
 * In-memory стаб `wxt/browser` для Node-тестів: рівно та частина API, якою
 * користується src/lib/vault-storage.ts (browser.storage.local get/set/remove).
 * Дані живуть у globalThis, тож переживають повторні import-и бандла
 * (імітація персистентності chrome.storage.local між рестартами SW).
 */
function store() {
  return (globalThis.__aiwalletTestStorage ??= new Map());
}

function keyList(keys) {
  return typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [...store().keys()];
}

export const browser = {
  storage: {
    local: {
      async get(keys) {
        const result = {};
        for (const key of keyList(keys)) {
          if (store().has(key)) result[key] = structuredClone(store().get(key));
        }
        return result;
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) {
          store().set(key, structuredClone(value));
        }
      },
      async remove(keys) {
        for (const key of keyList(keys)) store().delete(key);
      },
    },
  },
  runtime: {
    getURL: (path) => path,
  },
};
