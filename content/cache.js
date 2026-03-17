// Two-tier translation cache: L1 in-memory Map + L2 IndexedDB persistence
const TranslationCache = (() => {
  const memCache = new Map();
  const MAX_MEM = 500;
  const DB_NAME = 'llm-translator-cache';
  const STORE_NAME = 'translations';
  let db = null;

  // Open IndexedDB lazily
  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function makeKey(text, language) {
    return `${language || ''}|||${text}`;
  }

  // L1: sync memory lookup (instant, hot path)
  function get(text) {
    const val = memCache.get(text);
    if (val) {
      // LRU: move to end
      memCache.delete(text);
      memCache.set(text, val);
    }
    return val || null;
  }

  // L2: async IndexedDB lookup (few ms)
  async function getFromDB(text, language) {
    try {
      const store = await openDB();
      return new Promise((resolve) => {
        const tx = store.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(makeKey(text, language));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  // Write to both L1 and L2
  function set(text, translation, language) {
    // L1
    if (memCache.size >= MAX_MEM) {
      const firstKey = memCache.keys().next().value;
      memCache.delete(firstKey);
    }
    memCache.set(text, translation);

    // L2 (fire-and-forget)
    openDB()
      .then((store) => {
        const tx = store.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(translation, makeKey(text, language));
      })
      .catch(() => {});
  }

  function has(text) {
    return memCache.has(text);
  }

  function clear() {
    memCache.clear();
    openDB()
      .then((store) => {
        const tx = store.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
      })
      .catch(() => {});
  }

  return { get, getFromDB, set, has, clear };
})();
