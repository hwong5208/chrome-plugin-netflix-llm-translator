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

  // Helper — current language and model for cache keying
  function lang() { return settings.targetLanguage; }
  function model() { return settings.modelName; }

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
      if (
        event.data?.type === 'LLM_SUBTITLE_CUES' &&
        event.origin === window.location.origin &&
        settings.enabled
      ) {
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

    // Listen for messages from popup (e.g., clear cache)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'clearCache') {
        TranslationCache.clear();
        console.log('[LLM Translator] Cache cleared by user');
        sendResponse({ success: true });
      }
    });

    console.log('[LLM Translator] Initialized');
  }

  function startObserving() {
    NetflixSubtitles.start((text, container) => {
      handleNewSubtitle(text, container);
    });

    // Abort in-flight requests on seek/skip and re-prioritize prefetch
    NetflixSubtitles.onSeek(() => {
      Translator.abortAll();
      reprioritizePrefetch();
    });
  }

  // ── Prefetch queue ────────────────────────────────────────────────

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
    if (cueQueue.length > MAX_QUEUE) {
      cueQueue.splice(0, cueQueue.length - MAX_QUEUE);
    }

    // Add to pending prefetch queue
    for (const cue of cues) {
      if (!TranslationCache.has(cue, lang(), model())) {
        pendingCues.push(cue);
      }
    }

    if (!prefetchRunning) {
      runPrefetch();
    }
  }

  // Re-prioritize pending cues after a seek — move cues near current
  // playback position to the front of the queue
  function reprioritizePrefetch() {
    const currentText = NetflixSubtitles.getCurrentText();
    if (!currentText || pendingCues.length === 0) return;

    const currentIdx = cueQueue.indexOf(currentText);
    if (currentIdx === -1) return;

    // Sort pending cues by proximity to current position in cueQueue
    const posMap = new Map();
    for (let i = 0; i < cueQueue.length; i++) {
      posMap.set(cueQueue[i], i);
    }

    pendingCues.sort((a, b) => {
      const posA = posMap.get(a) ?? Infinity;
      const posB = posMap.get(b) ?? Infinity;
      return Math.abs(posA - currentIdx) - Math.abs(posB - currentIdx);
    });

    console.log(`[LLM Translator] Reprioritized ${pendingCues.length} pending cues around position ${currentIdx}`);
  }

  async function runPrefetch() {
    prefetchRunning = true;

    while (pendingCues.length > 0) {
      // Circuit breaker — pause prefetch if server is down
      if (Adaptive.isCircuitOpen()) {
        console.log('[LLM Translator] Prefetch paused — circuit breaker open');
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      // Snapshot current pending cues; new cues stay in pendingCues
      const processing = pendingCues.splice(0, pendingCues.length);
      const uncached = [];
      const seen = new Set();
      for (const cue of processing) {
        if (!TranslationCache.has(cue, lang(), model()) && !seen.has(cue)) {
          // Check IndexedDB L2
          const persisted = await TranslationCache.getFromDB(cue, lang(), model());
          if (persisted) {
            TranslationCache.set(cue, persisted, lang(), model());
          } else {
            uncached.push(cue);
            seen.add(cue);
          }
        }
      }

      if (uncached.length === 0) continue;

      const bs = Adaptive.getBatchSize();
      const wk = Adaptive.getConcurrency();
      console.log(
        `[LLM Translator] Prefetching ${uncached.length} cues (batch=${bs}, workers=${wk})`
      );

      // Split into batches using adaptive batch size
      const batches = [];
      for (let i = 0; i < uncached.length; i += bs) {
        batches.push(uncached.slice(i, i + bs));
      }

      // Process with adaptive concurrent workers
      let batchIdx = 0;
      const workers = Array.from({ length: wk }, async () => {
        while (batchIdx < batches.length) {
          const idx = batchIdx++;
          const batch = batches[idx];
          await doBatchTranslation(batch, idx + 1, batches.length);
        }
      });

      await Promise.all(workers);
    }

    console.log('[LLM Translator] Prefetch complete');
    prefetchRunning = false;
  }

  async function doBatchTranslation(batch, batchNum, totalBatches) {
    if (Adaptive.isCircuitOpen()) return;

    Adaptive.incrementActive();
    const t0 = performance.now();
    try {
      const translations = await Translator.translateBatch(batch, settings);
      const elapsed = performance.now() - t0;
      const count = Object.keys(translations).length;

      for (const [original, translated] of Object.entries(translations)) {
        TranslationCache.set(original, translated, lang(), model());
      }
      console.log(
        `[LLM Translator] Batch ${batchNum}/${totalBatches}: ${count}/${batch.length} cached (${Math.round(elapsed)}ms)`
      );

      Adaptive.record(elapsed, true);
    } catch (err) {
      if (err.message === 'Request aborted') {
        // Don't count aborts as failures
        return;
      }
      Adaptive.record(0, false);
      console.warn(
        `[LLM Translator] Batch ${batchNum} failed: ${err.message}, falling back to individual`
      );
      // Fallback: translate individually — feed results back to adaptive
      let fallbackOk = 0, fallbackFail = 0;
      for (const text of batch) {
        if (TranslationCache.has(text, lang(), model())) continue;
        if (Adaptive.isCircuitOpen()) break;
        const ft0 = performance.now();
        try {
          const translation = await Translator.translate(text, settings);
          TranslationCache.set(text, translation, lang(), model());
          fallbackOk++;
          Adaptive.record(performance.now() - ft0, true);
        } catch (e) {
          if (e.message === 'Request aborted') break;
          fallbackFail++;
          Adaptive.record(0, false);
        }
      }
      if (fallbackOk + fallbackFail > 0) {
        console.log(`[LLM Translator] Fallback: ${fallbackOk} ok, ${fallbackFail} failed`);
      }
    } finally {
      Adaptive.decrementActive();
    }
  }

  // ── Subtitle display with lookahead ─────────────────────────────────

  async function handleNewSubtitle(text, container) {
    // Circuit breaker — show originals if server is down
    if (Adaptive.isCircuitOpen()) {
      NetflixSubtitles.showOriginalSubtitles();
      return;
    }

    // L1: sync memory cache (instant)
    const cached = TranslationCache.get(text, lang(), model());
    if (cached) {
      NetflixSubtitles.displayTranslation(container, text, cached);
      triggerLookahead(text);
      return;
    }

    // L2: async IndexedDB cache (few ms)
    const persisted = await TranslationCache.getFromDB(text, lang(), model());
    if (persisted) {
      TranslationCache.set(text, persisted, lang(), model());
      if (NetflixSubtitles.getCurrentText() === text) {
        NetflixSubtitles.displayTranslation(container, text, persisted);
      }
      triggerLookahead(text);
      return;
    }

    // Cache miss — keep Netflix original visible while translating
    NetflixSubtitles.showOriginalSubtitles();
    triggerLookahead(text);

    // Retry up to 2 times on failure, fallback to showing originals
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (Adaptive.isCircuitOpen()) break;
      try {
        const translation = await Translator.translate(text, settings);
        TranslationCache.set(text, translation, lang(), model());

        if (NetflixSubtitles.getCurrentText() === text) {
          NetflixSubtitles.displayTranslation(container, text, translation);
        }
        return;
      } catch (err) {
        if (err.message === 'Request aborted') return;
        console.warn(
          `[LLM Translator] Translation attempt ${attempt + 1}/${MAX_RETRIES + 1} failed:`,
          err.message
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    console.warn('[LLM Translator] All retries failed, showing original subtitles');
    NetflixSubtitles.showOriginalSubtitles();
  }

  // Translate next N uncached cues after the current one.
  // Respects adaptive concurrency — skips if server is already saturated.
  function triggerLookahead(currentText) {
    if (Adaptive.shouldThrottle()) return;
    if (Adaptive.isCircuitOpen()) return;

    const LOOKAHEAD = 5;
    const idx = cueQueue.indexOf(currentText);
    if (idx === -1) return;

    const upcoming = [];
    for (let i = idx + 1; i < cueQueue.length && upcoming.length < LOOKAHEAD; i++) {
      if (!TranslationCache.has(cueQueue[i], lang(), model())) {
        upcoming.push(cueQueue[i]);
      }
    }

    if (upcoming.length > 0) {
      doBatchTranslation(upcoming, 0, 0).catch(() => {});
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
