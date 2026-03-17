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

  // ── Adaptive throughput controller ──────────────────────────────────
  // Dynamically adjusts batch size and worker count based on observed
  // LLM response times. Starts conservative, scales up when fast,
  // backs off when slow or errors occur.

  const adaptive = {
    batchSize: 5,       // current batch size (starts conservative)
    concurrency: 2,     // current worker count
    activeRequests: 0,  // tracks ALL in-flight requests (prefetch + lookahead)
    MIN_BATCH: 2,
    MAX_BATCH: 15,
    MIN_WORKERS: 1,
    MAX_WORKERS: 5,
    latencies: [],      // rolling window of recent batch latencies (ms)
    WINDOW: 8,          // number of samples to keep
    errors: 0,          // consecutive error count
    cooldown: 0,        // batches to skip before next adjust (prevents oscillation)
    COOLDOWN_PERIOD: 4, // skip this many batches after each scale change
    FAST_MS: 2000,      // below this = scale up
    SLOW_MS: 6000,      // above this = scale down

    record(latencyMs, success) {
      if (!success) {
        this.errors++;
        this.scaleDown();
        return;
      }
      this.errors = 0;
      this.latencies.push(latencyMs);
      if (this.latencies.length > this.WINDOW) this.latencies.shift();
      this.adjust();
    },

    avgLatency() {
      if (this.latencies.length === 0) return this.SLOW_MS;
      return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    },

    adjust() {
      if (this.latencies.length < 3) return; // need enough samples
      if (this.cooldown > 0) { this.cooldown--; return; } // wait for cooldown
      const avg = this.avgLatency();
      if (avg < this.FAST_MS) {
        this.scaleUp();
      } else if (avg > this.SLOW_MS) {
        this.scaleDown();
      }
    },

    scaleUp() {
      const oldB = this.batchSize, oldW = this.concurrency;
      this.batchSize = Math.min(this.batchSize + 2, this.MAX_BATCH);
      this.concurrency = Math.min(this.concurrency + 1, this.MAX_WORKERS);
      if (this.batchSize !== oldB || this.concurrency !== oldW) {
        this.cooldown = this.COOLDOWN_PERIOD;
        console.log(`[LLM Adaptive] Scale UP → batch=${this.batchSize} workers=${this.concurrency} (avg ${Math.round(this.avgLatency())}ms)`);
      }
    },

    scaleDown() {
      const oldB = this.batchSize, oldW = this.concurrency;
      this.batchSize = Math.max(Math.floor(this.batchSize * 0.6), this.MIN_BATCH);
      this.concurrency = Math.max(this.concurrency - 1, this.MIN_WORKERS);
      if (this.batchSize !== oldB || this.concurrency !== oldW) {
        this.cooldown = this.COOLDOWN_PERIOD;
        console.log(`[LLM Adaptive] Scale DOWN → batch=${this.batchSize} workers=${this.concurrency} (avg ${Math.round(this.avgLatency())}ms, errors=${this.errors})`);
      }
    },
  };

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
      // Snapshot current pending cues; new cues added during async iteration
      // stay in pendingCues and are picked up by the next while-loop pass.
      const processing = pendingCues.splice(0, pendingCues.length);
      const uncached = [];
      const seen = new Set();
      for (const cue of processing) {
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

      if (uncached.length === 0) continue;

      const bs = adaptive.batchSize;
      const wk = adaptive.concurrency;
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
          await translateBatch(batch, idx + 1, batches.length);
        }
      });

      await Promise.all(workers);
    }

    console.log('[LLM Translator] Prefetch complete');
    prefetchRunning = false;
  }

  async function translateBatch(batch, batchNum, totalBatches) {
    adaptive.activeRequests++;
    const t0 = performance.now();
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

      const elapsed = performance.now() - t0;

      if (response.translations) {
        const count = Object.keys(response.translations).length;
        for (const [original, translated] of Object.entries(
          response.translations
        )) {
          TranslationCache.set(original, translated, settings.targetLanguage);
        }
        console.log(
          `[LLM Translator] Batch ${batchNum}/${totalBatches}: ${count}/${batch.length} cached (${Math.round(elapsed)}ms)`
        );
      }

      adaptive.record(elapsed, true);
    } catch (err) {
      adaptive.record(0, false);
      console.warn(
        `[LLM Translator] Batch ${batchNum} failed: ${err.message}, falling back to individual`
      );
      // Fallback: translate individually — feed results back to adaptive
      let fallbackOk = 0, fallbackFail = 0;
      for (const text of batch) {
        if (TranslationCache.has(text)) continue;
        const ft0 = performance.now();
        try {
          const translation = await Translator.translate(text, settings);
          TranslationCache.set(text, translation, settings.targetLanguage);
          fallbackOk++;
          adaptive.record(performance.now() - ft0, true);
        } catch (e) {
          fallbackFail++;
          adaptive.record(0, false);
        }
      }
      if (fallbackOk + fallbackFail > 0) {
        console.log(`[LLM Translator] Fallback: ${fallbackOk} ok, ${fallbackFail} failed`);
      }
    } finally {
      adaptive.activeRequests--;
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

  // Translate next N uncached cues after the current one.
  // Respects adaptive concurrency — skips if server is already saturated.
  function triggerLookahead(currentText) {
    // Don't add more load if active requests already exceed adaptive target
    if (adaptive.activeRequests >= adaptive.concurrency + 1) return;

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
