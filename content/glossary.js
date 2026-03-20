// Self-building glossary for consistent character/place name translations.
// Detects proper nouns from subtitles, translates via LLM, persists per show in IndexedDB.
var Glossary = (() => {
  const DB_NAME = 'llm-glossary';
  const DB_VERSION = 1;
  const STORE_NAME = 'glossaries';

  let db = null;
  let currentShow = '';
  let currentLang = '';
  let entries = {};
  let detectedNames = new Set();
  let translatingNames = false;
  let translateTimer = null;
  let lastSettings = null;
  let translateFailures = 0;
  const MAX_TRANSLATE_FAILURES = 3;

  // Common always-capitalized English words to exclude from name detection
  const SKIP_WORDS = new Set([
    'I', 'OK', 'TV', 'US', 'UK', 'EU', 'UN', 'FBI', 'CIA', 'NASA', 'DNA', 'CEO',
    'Mr', 'Mrs', 'Ms', 'Dr', 'Jr', 'Sr', 'Prof',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
    'God', 'Jesus', 'Christmas', 'Easter', 'Halloween',
    'English', 'French', 'Spanish', 'Japanese', 'Chinese', 'German',
    'Korean', 'Italian', 'Russian', 'Portuguese', 'Arabic',
    'American', 'British', 'European', 'Asian', 'African',
    'Hey', 'Oh', 'Wow', 'Yes', 'No', 'Okay', 'Well', 'So', 'But', 'And',
    'The', 'This', 'That', 'What', 'Why', 'How', 'Who', 'Where', 'When',
    'He', 'She', 'We', 'They', 'You', 'My', 'His', 'Her', 'Our', 'Your',
    'Its', 'If', 'Or', 'Not', 'All', 'Can', 'Will', 'Just', 'Now', 'Then',
    'Sir', 'Ma', 'Miss', 'Lord', 'Lady', 'King', 'Queen', 'Prince', 'Princess',
    'North', 'South', 'East', 'West',
    'Ah', 'Uh', 'Um', 'Hmm', 'Huh', 'Whoa',
  ]);

  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function dbKey(show, lang) {
    return JSON.stringify([show, lang]);
  }

  async function load(showTitle, language) {
    if (!showTitle) return;
    if (showTitle === currentShow && language === currentLang) return;

    currentShow = showTitle;
    currentLang = language;
    entries = {};
    detectedNames.clear();
    if (translateTimer) { clearTimeout(translateTimer); translateTimer = null; }

    try {
      const store = await openDB();
      return new Promise((resolve) => {
        const tx = store.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(dbKey(showTitle, language));
        req.onsuccess = () => {
          if (req.result && typeof req.result === 'object') {
            entries = req.result;
            console.log(`[Glossary] Loaded ${Object.keys(entries).length} entries for "${showTitle}"`);
          }
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch (err) {
      console.warn('[Glossary] DB load failed:', err);
    }
  }

  function save() {
    if (!currentShow) return;
    openDB().then((store) => {
      const tx = store.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...entries }, dbKey(currentShow, currentLang));
    }).catch((err) => {
      console.warn('[Glossary] Failed to persist:', err.message);
    });
  }

  function getEntries() { return entries; }
  function getShowTitle() { return currentShow; }
  function getPendingCount() { return detectedNames.size; }

  // Scan subtitle text for potential proper nouns (capitalized words mid-sentence)
  function detectNames(text) {
    if (!currentShow) return;

    const lines = text.split('\n');
    for (const line of lines) {
      const words = line.split(/\s+/);
      let i = 0;
      while (i < words.length) {
        // Skip first word of line (always capitalized as sentence start)
        if (i === 0) { i++; continue; }
        // Skip word after sentence-ending punctuation
        if (i > 0 && /[.!?]$/.test(words[i - 1])) { i++; continue; }

        const clean = words[i].replace(/[^a-zA-Z'-]/g, '');
        if (!clean || clean.length < 2) { i++; continue; }

        // Must start with uppercase and not be all-uppercase (acronyms/emphasis)
        if (clean[0] !== clean[0].toUpperCase() || clean === clean.toLowerCase()) {
          i++; continue;
        }
        if (clean.length > 1 && clean === clean.toUpperCase()) { i++; continue; }

        if (SKIP_WORDS.has(clean)) { i++; continue; }

        // Collect consecutive capitalized words (multi-word names like "Monkey D Luffy")
        const parts = [clean];
        let j = i + 1;
        while (j < words.length) {
          const next = words[j].replace(/[^a-zA-Z'-]/g, '');
          if (next && next.length >= 2 &&
              next[0] === next[0].toUpperCase() && next !== next.toLowerCase() &&
              !(next.length > 1 && next === next.toUpperCase()) &&
              !SKIP_WORDS.has(next)) {
            parts.push(next);
            j++;
          } else {
            break;
          }
        }

        const fullName = parts.join(' ');
        if (!entries[fullName]) {
          detectedNames.add(fullName);
        }

        i = j;
      }
    }
  }

  // Schedule name translation with 5s debounce to batch discoveries
  function maybeTranslate(settings) {
    lastSettings = settings;
    if (translatingNames || detectedNames.size === 0 || !currentShow) return;
    if (translateTimer) return;
    if (translateFailures >= MAX_TRANSLATE_FAILURES) return; // stop after repeated failures

    translateTimer = setTimeout(() => {
      translateTimer = null;
      doTranslate(lastSettings);
    }, 5000);
  }

  async function doTranslate(settings) {
    if (translatingNames || detectedNames.size === 0) return;

    translatingNames = true;
    const names = [...detectedNames];
    detectedNames.clear();

    try {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), 30000);
        chrome.runtime.sendMessage({
          type: 'translateNames',
          names,
          showTitle: currentShow,
          settings,
        }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp?.error) return reject(new Error(resp.error));
          resolve(resp);
        });
      });

      if (response?.translations) {
        let added = 0;
        for (const [name, translation] of Object.entries(response.translations)) {
          if (translation) {
            entries[name] = translation;
            added++;
          }
        }
        if (added > 0) {
          save();
          translateFailures = 0; // reset on success
          console.log(`[Glossary] Added ${added} name translations for "${currentShow}"`);
        }
      }
    } catch (err) {
      translateFailures++;
      if (translateFailures < MAX_TRANSLATE_FAILURES) {
        // Put names back for retry
        for (const n of names) {
          if (!entries[n]) detectedNames.add(n);
        }
      } else {
        console.warn('[Glossary] Max retries reached, stopping name translation');
      }
      console.warn('[Glossary] Name translation failed:', err.message);
    } finally {
      translatingNames = false;
    }
  }

  function clear() {
    entries = {};
    detectedNames.clear();
    currentShow = '';
    currentLang = '';
    lastSettings = null;
    translateFailures = 0;
    if (translateTimer) { clearTimeout(translateTimer); translateTimer = null; }
  }

  return { load, getEntries, getShowTitle, getPendingCount, detectNames, maybeTranslate, clear };
})();
