// Learn English mode — hover-to-explain word tooltip
// Creates an interactive subtitle overlay where each word is hoverable.
// On subtitle appear, batch-explains all words via LLM so hover is instant.
// Uses built-in dictionary for common words (instant) and LLM for the rest.
// eslint-disable-next-line no-var
var WordExplain = (() => {
  const MAX_CACHE = 500;
  const cache = new Map(); // word.toLowerCase() → { translation, pronunciation, type, context }
  let learnOverlay = null;
  let tooltipEl = null;
  let currentHoverWord = null; // DOM element currently hovered
  let hoverDebounceId = null;  // debounce timer for hover
  let prefetchAbort = null; // AbortController for current prefetch
  let currentSettings = null; // settings ref for LLM calls

  // ── Overlay rendering ──────────────────────────────────────────────

  function getAppendTarget() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
  }

  function getOrCreateOverlay() {
    const target = getAppendTarget();
    if (learnOverlay && document.contains(learnOverlay)) {
      if (learnOverlay.parentElement !== target) {
        target.appendChild(learnOverlay);
      }
      return learnOverlay;
    }
    learnOverlay = document.createElement('div');
    learnOverlay.id = 'llm-learn-overlay';
    target.appendChild(learnOverlay);

    // Delegate hover events on the overlay
    learnOverlay.addEventListener('mouseenter', onWordEnter, true);
    learnOverlay.addEventListener('mouseleave', onWordLeave, true);

    return learnOverlay;
  }

  function renderSubtitle(text, provider, settings) {
    hideTooltip();
    currentHoverWord = null;
    currentSettings = settings;

    // Abort any in-flight prefetch for the previous subtitle
    if (prefetchAbort) {
      prefetchAbort.abort();
      prefetchAbort = null;
    }

    const overlay = getOrCreateOverlay();
    overlay.innerHTML = '';
    overlay.classList.remove('llm-visible');

    const lang = settings.targetLanguage;

    // Collect unique words that need LLM explanation
    const wordsToExplain = [];
    const seenWords = new Set();

    // Split multi-line subtitles into separate lines
    const lines = text.split('\n');
    for (const line of lines) {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'llm-learn-line';

      // Split into words, keeping whitespace
      const tokens = line.split(/(\s+)/);
      for (const token of tokens) {
        if (token.trim() === '') {
          lineDiv.appendChild(document.createTextNode(token));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'llm-word';
        span.textContent = token;
        // Strip punctuation for the lookup word
        const cleanWord = token.replace(/[^\w'-]/g, '');
        span.dataset.word = cleanWord;
        span.dataset.sentence = line;
        lineDiv.appendChild(span);

        // Collect for prefetch: skip empty, skip dictionary words, skip cached
        const wordLower = cleanWord.toLowerCase();
        if (cleanWord && !seenWords.has(wordLower) &&
            !cache.has(wordLower) &&
            !CommonDictionary.has(cleanWord, lang)) {
          wordsToExplain.push({ word: cleanWord, sentence: line });
          seenWords.add(wordLower);
        }
      }

      overlay.appendChild(lineDiv);
    }

    overlay.style.display = 'flex';
    overlay.offsetHeight; // force layout
    overlay.classList.add('llm-visible');
    provider.hideOriginalSubtitles();

    // Prefetch only words that aren't in dictionary or cache
    if (wordsToExplain.length > 0) {
      prefetchWords(wordsToExplain, settings);
    }
  }

  // ── Batch prefetch ─────────────────────────────────────────────────

  async function prefetchWords(wordList, settings) {
    prefetchAbort = new AbortController();
    const signal = prefetchAbort.signal;

    // Extract unique words and the full sentence for context
    const sentence = wordList[0].sentence;
    const words = wordList.map((w) => w.word);

    try {
      const result = await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Aborted'));

        const timer = setTimeout(() => reject(new Error('Timeout')), 60000);
        const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });

        chrome.runtime.sendMessage(
          { type: 'explainWordBatch', words, sentence, settings },
          (resp) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            if (signal.aborted) return reject(new Error('Aborted'));
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (resp?.error) return reject(new Error(resp.error));
            resolve(resp.explanations);
          }
        );
      });

      // Cache all results by word only (not word|sentence)
      if (result && typeof result === 'object') {
        for (const [word, data] of Object.entries(result)) {
          cacheSet(word.toLowerCase(), data);
        }
        console.log(`[LLM Translator] Prefetched ${Object.keys(result).length} word explanations`);
      }
    } catch (err) {
      if (err.message === 'Aborted') return;
      console.warn('[LLM Translator] Word prefetch failed:', err.message);
    }
  }

  // Prefetch words from upcoming subtitles (called from content.js lookahead)
  function prefetchUpcoming(cues, settings) {
    const lang = settings.targetLanguage;
    const wordsToExplain = [];
    const seenWords = new Set();

    for (const cue of cues) {
      const tokens = cue.split(/\s+/);
      for (const token of tokens) {
        const cleanWord = token.replace(/[^\w'-]/g, '');
        if (!cleanWord) continue;
        const wordLower = cleanWord.toLowerCase();
        if (seenWords.has(wordLower)) continue;
        if (cache.has(wordLower)) continue;
        if (CommonDictionary.has(cleanWord, lang)) continue;
        seenWords.add(wordLower);
        wordsToExplain.push({ word: cleanWord, sentence: cue });
      }
    }

    if (wordsToExplain.length > 0) {
      prefetchWords(wordsToExplain, settings);
    }
  }

  // Re-parent overlays when entering/exiting fullscreen
  function handleFullscreenChange() {
    const target = getAppendTarget();
    if (learnOverlay && document.contains(learnOverlay) && learnOverlay.parentElement !== target) {
      target.appendChild(learnOverlay);
    }
    if (tooltipEl && document.contains(tooltipEl) && tooltipEl.parentElement !== target) {
      target.appendChild(tooltipEl);
    }
  }
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

  function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, value);
  }

  // Check if a word is already explained (dictionary or cache)
  function hasExplanation(word, targetLanguage) {
    return cache.has(word.toLowerCase()) || CommonDictionary.has(word, targetLanguage);
  }

  function destroy() {
    hideTooltip();
    currentHoverWord = null;
    currentSettings = null;
    if (hoverDebounceId) {
      clearTimeout(hoverDebounceId);
      hoverDebounceId = null;
    }
    if (prefetchAbort) {
      prefetchAbort.abort();
      prefetchAbort = null;
    }
    if (learnOverlay) {
      learnOverlay.remove();
      learnOverlay = null;
    }
  }

  function clearCache() {
    cache.clear();
  }

  // ── Hover events (delegated, debounced) ─────────────────────────────

  function onWordEnter(e) {
    const wordEl = e.target.closest('.llm-word');
    if (!wordEl) return;
    currentHoverWord = wordEl;

    // Debounce: skip accidental hovers when mouse sweeps across words
    if (hoverDebounceId) clearTimeout(hoverDebounceId);
    hoverDebounceId = setTimeout(() => {
      hoverDebounceId = null;
      if (currentHoverWord === wordEl) {
        showTooltip(wordEl);
      }
    }, 120);
  }

  function onWordLeave(e) {
    const wordEl = e.target.closest('.llm-word');
    if (!wordEl) return;
    if (wordEl === currentHoverWord) {
      if (hoverDebounceId) {
        clearTimeout(hoverDebounceId);
        hoverDebounceId = null;
      }
      hideTooltip();
      currentHoverWord = null;
    }
  }

  // ── Tooltip ────────────────────────────────────────────────────────

  function getOrCreateTooltip() {
    const target = getAppendTarget();
    if (tooltipEl && document.contains(tooltipEl)) {
      if (tooltipEl.parentElement !== target) {
        target.appendChild(tooltipEl);
      }
      return tooltipEl;
    }
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'llm-word-tooltip';
    target.appendChild(tooltipEl);
    return tooltipEl;
  }

  function positionTooltip(wordEl) {
    const tip = getOrCreateTooltip();
    const rect = wordEl.getBoundingClientRect();

    // Show tooltip so we can measure it
    tip.style.display = 'block';
    tip.style.visibility = 'hidden';
    tip.offsetHeight; // force layout

    const tipRect = tip.getBoundingClientRect();
    const pad = 16;

    // Default: above the word
    let top = rect.top - tipRect.height - 8;
    if (top < pad) {
      // Fallback: below the word
      top = rect.bottom + 8;
    }

    // Center horizontally on the word, clamp to viewport
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad));

    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
    tip.style.visibility = '';
  }

  async function showTooltip(wordEl) {
    const word = wordEl.dataset.word;
    const sentence = wordEl.dataset.sentence || '';
    if (!word) return;

    const wordLower = word.toLowerCase();
    const tip = getOrCreateTooltip();
    const settings = currentSettings;
    const lang = settings?.targetLanguage;

    // 1. Built-in dictionary — instant, no LLM needed
    if (lang && CommonDictionary.has(word, lang)) {
      renderTooltipContent(tip, word, CommonDictionary.lookup(word, lang));
      positionTooltip(wordEl);
      tip.classList.add('visible');
      return;
    }

    // 2. LLM cache hit — instant
    if (cache.has(wordLower)) {
      renderTooltipContent(tip, word, cache.get(wordLower));
      positionTooltip(wordEl);
      tip.classList.add('visible');
      return;
    }

    // 3. Cache miss — show loading, fall back to single LLM request
    tip.innerHTML = '<div class="tooltip-loading">...</div>';
    positionTooltip(wordEl);
    tip.classList.add('visible');

    if (!settings) return;

    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), 30000);
        chrome.runtime.sendMessage(
          { type: 'explainWord', word, sentence, settings },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) {
              reject(new Error(resp.error));
              return;
            }
            resolve(resp.explanation);
          }
        );
      });

      cacheSet(wordLower, result);

      // Only update if still hovering the same word
      if (currentHoverWord === wordEl) {
        renderTooltipContent(tip, word, result);
        positionTooltip(wordEl);
      }
    } catch (err) {
      console.warn('[LLM Translator] Word explain failed:', err.message);
      if (currentHoverWord === wordEl) {
        tip.innerHTML = '<div class="tooltip-loading">Failed to load</div>';
      }
    }
  }

  function renderTooltipContent(tip, word, data) {
    tip.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'tooltip-header';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'tooltip-word';
    wordSpan.textContent = word;
    header.appendChild(wordSpan);

    if (data.pronunciation) {
      const pronSpan = document.createElement('span');
      pronSpan.className = 'tooltip-pronunciation';
      pronSpan.textContent = data.pronunciation;
      header.appendChild(pronSpan);
    }

    if (data.type) {
      const posSpan = document.createElement('span');
      posSpan.className = 'tooltip-pos';
      posSpan.textContent = data.type;
      header.appendChild(posSpan);
    }

    tip.appendChild(header);

    if (data.translation) {
      const transDiv = document.createElement('div');
      transDiv.className = 'tooltip-translation';
      transDiv.textContent = data.translation;
      tip.appendChild(transDiv);
    }

    if (data.context) {
      const ctxDiv = document.createElement('div');
      ctxDiv.className = 'tooltip-context';
      ctxDiv.textContent = data.context;
      tip.appendChild(ctxDiv);
    }
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.classList.remove('visible');
    }
  }

  return { renderSubtitle, destroy, clearCache, prefetchUpcoming, hasExplanation };
})();
