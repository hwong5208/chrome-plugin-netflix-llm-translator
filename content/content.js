// Main orchestrator for the subtitle translation extension
(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    apiEndpoint: 'http://10.0.0.7:8000/v1/chat/completions',
    modelName: 'Qwen3.5-9B-MLX-4bit',
    apiKey: '',
    targetLanguage: 'Traditional Chinese',
    systemPrompt:
      'You are a subtitle translator. Translate the following subtitle text into {{targetLanguage}}. Output only the translation. Keep it natural and concise for subtitles. Do not add quotation marks, explanations, or annotations.',
    fontSize: '2.8vw',
    subtitleColor: '#ffffff',
  };

  let settings = { ...DEFAULT_SETTINGS };
  let cueQueue = []; // ordered list of all known cues for lookahead
  const MAX_QUEUE = 1000;

  async function init() {
    console.log('[LLM Translator] Loading...');

    const stored = await new Promise((resolve) => {
      chrome.storage.sync.get('llmTranslatorSettings', (result) => {
        resolve(result.llmTranslatorSettings || null);
      });
    });

    if (stored) {
      settings = { ...DEFAULT_SETTINGS, ...stored };
    }

    console.log('[LLM Translator] Settings:', {
      enabled: settings.enabled,
      apiEndpoint: settings.apiEndpoint,
      modelName: settings.modelName,
      targetLanguage: settings.targetLanguage,
    });

    // Listen for prefetched subtitle cues from MAIN world script
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'LLM_SUBTITLE_CUES' && settings.enabled) {
        enqueueCues(event.data.cues);
      }
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.llmTranslatorSettings) {
        settings = {
          ...DEFAULT_SETTINGS,
          ...changes.llmTranslatorSettings.newValue,
        };
        updateSubtitleStyle();

        if (!settings.enabled) {
          NetflixSubtitles.stop();
        } else {
          startObserving();
        }
      }
    });

    if (settings.enabled) {
      startObserving();
    }

    console.log('[LLM Translator] Initialized');
  }

  function startObserving() {
    NetflixSubtitles.start((text, container) => {
      handleNewSubtitle(text, container);
    });
  }

  // ── Prefetch queue: merge new cues, never drop ──────────────────────

  let prefetchRunning = false;
  let pendingCues = [];

  function enqueueCues(cues) {
    // Merge into known cue list (for lookahead), cap at MAX_QUEUE
    const known = new Set(cueQueue);
    for (const cue of cues) {
      if (!known.has(cue)) {
        cueQueue.push(cue);
        known.add(cue);
      }
    }
    // Fix #6: Trim oldest entries to prevent unbounded growth
    if (cueQueue.length > MAX_QUEUE) {
      cueQueue.splice(0, cueQueue.length - MAX_QUEUE);
    }

    // Add to pending prefetch queue
    for (const cue of cues) {
      if (!TranslationCache.has(cue)) {
        pendingCues.push(cue);
      }
    }

    if (!prefetchRunning) {
      runPrefetch();
    }
  }

  async function runPrefetch() {
    prefetchRunning = true;

    while (pendingCues.length > 0) {
      // Dedup against cache (some may have been translated while waiting)
      const uncached = [];
      const seen = new Set();
      for (const cue of pendingCues) {
        if (!TranslationCache.has(cue) && !seen.has(cue)) {
          // Check IndexedDB L2
          const persisted = await TranslationCache.getFromDB(
            cue,
            settings.targetLanguage
          );
          if (persisted) {
            TranslationCache.set(cue, persisted, settings.targetLanguage);
          } else {
            uncached.push(cue);
            seen.add(cue);
          }
        }
      }
      pendingCues = [];

      if (uncached.length === 0) continue;

      console.log(
        `[LLM Translator] Prefetching ${uncached.length} cues (3 parallel workers)`
      );

      // Split into batches of 10
      const BATCH_SIZE = 10;
      const batches = [];
      for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        batches.push(uncached.slice(i, i + BATCH_SIZE));
      }

      // Process with 3 concurrent workers
      const CONCURRENCY = 3;
      let batchIdx = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (batchIdx < batches.length) {
          const idx = batchIdx++;
          const batch = batches[idx];
          await translateBatch(batch, idx + 1, batches.length);
        }
      });

      await Promise.all(workers);
    }

    console.log('[LLM Translator] Prefetch complete');
    prefetchRunning = false;
  }

  async function translateBatch(batch, batchNum, totalBatches) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'translateBatch', texts: batch, settings },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) {
              reject(new Error(resp.error));
              return;
            }
            resolve(resp);
          }
        );
      });

      if (response.translations) {
        const count = Object.keys(response.translations).length;
        for (const [original, translated] of Object.entries(
          response.translations
        )) {
          TranslationCache.set(original, translated, settings.targetLanguage);
        }
        console.log(
          `[LLM Translator] Batch ${batchNum}/${totalBatches}: ${count}/${batch.length} cached`
        );
      }
    } catch (err) {
      console.warn(
        `[LLM Translator] Batch ${batchNum} failed: ${err.message}, falling back to individual`
      );
      // Fallback: translate individually
      for (const text of batch) {
        if (TranslationCache.has(text)) continue;
        try {
          const translation = await Translator.translate(text, settings);
          TranslationCache.set(text, translation, settings.targetLanguage);
        } catch (e) {}
      }
    }
  }

  // ── Subtitle display with lookahead ─────────────────────────────────

  async function handleNewSubtitle(text, container) {
    // L1: sync memory cache (instant)
    const cached = TranslationCache.get(text);
    if (cached) {
      NetflixSubtitles.displayTranslation(container, text, cached);
      triggerLookahead(text);
      return;
    }

    // L2: async IndexedDB cache (few ms)
    const persisted = await TranslationCache.getFromDB(
      text,
      settings.targetLanguage
    );
    if (persisted) {
      TranslationCache.set(text, persisted, settings.targetLanguage);
      if (NetflixSubtitles.getCurrentText() === text) {
        NetflixSubtitles.displayTranslation(container, text, persisted);
      }
      triggerLookahead(text);
      return;
    }

    // Cache miss — keep Netflix original visible while translating
    NetflixSubtitles.showOriginalSubtitles();

    // Kick off lookahead for upcoming cues in parallel
    triggerLookahead(text);

    // Fix #4: Retry up to 2 times on failure, fallback to showing originals
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const translation = await Translator.translate(text, settings);
        TranslationCache.set(text, translation, settings.targetLanguage);

        // Only show if this subtitle is still on screen
        if (NetflixSubtitles.getCurrentText() === text) {
          NetflixSubtitles.displayTranslation(container, text, translation);
        }
        return; // success — exit retry loop
      } catch (err) {
        console.warn(
          `[LLM Translator] Translation attempt ${attempt + 1}/${MAX_RETRIES + 1} failed:`,
          err.message
        );
        if (attempt < MAX_RETRIES) {
          // Brief backoff before retry
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    // All retries exhausted — ensure Netflix originals are visible
    console.warn('[LLM Translator] All retries failed, showing original subtitles');
    NetflixSubtitles.showOriginalSubtitles();
  }

  // Translate next N uncached cues after the current one
  function triggerLookahead(currentText) {
    const LOOKAHEAD = 5;
    const idx = cueQueue.indexOf(currentText);
    if (idx === -1) return;

    const upcoming = [];
    for (let i = idx + 1; i < cueQueue.length && upcoming.length < LOOKAHEAD; i++) {
      if (!TranslationCache.has(cueQueue[i])) {
        upcoming.push(cueQueue[i]);
      }
    }

    if (upcoming.length > 0) {
      // Fire-and-forget batch for upcoming cues
      translateBatch(upcoming, 0, 0).catch(() => {});
    }
  }

  // ── Dynamic style ───────────────────────────────────────────────────

  function updateSubtitleStyle() {
    const styleId = 'llm-translator-dynamic-style';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    const size = settings.fontSize;
    const smallerSize = size.includes('vw')
      ? (parseFloat(size) * 0.875).toFixed(1) + 'vw'
      : size;
    styleEl.textContent = `
      #llm-translation-overlay .llm-original-line {
        font-size: ${size} !important;
      }
      #llm-translation-overlay .llm-translated-line {
        font-size: ${smallerSize} !important;
        color: ${settings.subtitleColor} !important;
      }
    `;
  }

  updateSubtitleStyle();
  init();
})();
