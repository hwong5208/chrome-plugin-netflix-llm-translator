// Two-tier translation cache: L1 in-memory Map + L2 IndexedDB persistence
const TranslationCache = (() => {
  const memCache = new Map(); // key: makeKey(text, language) -> translation
  const MAX_MEM = 500;
  const DB_NAME = 'llm-translator-cache';
  const DB_VERSION = 2; // bumped for TTL store migration
  const STORE_NAME = 'translations';
  const TTL_DAYS = 30;
  let db = null;

  // Open IndexedDB lazily
  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const d = req.result;
        // v1: plain key-value store
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Collision-safe cache key incorporating language and model
  function makeKey(text, language, model) {
    return JSON.stringify([language || '', model || '', text]);
  }

  // L1 key (same format as L2)
  function l1Key(text, language, model) {
    return makeKey(text, language, model);
  }

  // L1: sync memory lookup (instant, hot path)
  function get(text, language, model) {
    const key = l1Key(text, language, model);
    const val = memCache.get(key);
    if (val) {
      // LRU: move to end
      memCache.delete(key);
      memCache.set(key, val);
    }
    return val || null;
  }

  // L2: async IndexedDB lookup (few ms)
  async function getFromDB(text, language, model) {
    try {
      const store = await openDB();
      return new Promise((resolve) => {
        const tx = store.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(makeKey(text, language, model));
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry) return resolve(null);
          // Support both old (plain string) and new ({ translation, ts }) formats
          if (typeof entry === 'string') return resolve(entry);
          if (entry.translation) {
            // Check TTL
            if (entry.ts && Date.now() - entry.ts > TTL_DAYS * 86400000) {
              // Expired — delete and return null
              deleteFromDB(text, language, model);
              return resolve(null);
            }
            return resolve(entry.translation);
          }
          resolve(null);
        };
        req.onerror = () => {
          console.warn('[LLM Cache] DB read error:', req.error);
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('[LLM Cache] DB access failed:', err);
      return null;
    }
  }

  // Write to both L1 and L2
  function set(text, translation, language, model) {
    const key = l1Key(text, language, model);
    // L1
    if (memCache.size >= MAX_MEM) {
      const firstKey = memCache.keys().next().value;
      memCache.delete(firstKey);
    }
    memCache.set(key, translation);

    // L2 (fire-and-forget) — store with timestamp for TTL
    openDB()
      .then((store) => {
        const tx = store.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(
          { translation, ts: Date.now() },
          makeKey(text, language, model)
        );
      })
      .catch(() => {});
  }

  function has(text, language, model) {
    return memCache.has(l1Key(text, language, model));
  }

  function deleteFromDB(text, language, model) {
    openDB()
      .then((store) => {
        const tx = store.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(makeKey(text, language, model));
      })
      .catch(() => {});
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
