// Amazon Prime Video subtitle detection and injection
// Implements the same SubtitleProvider interface as NetflixSubtitles:
//   start(callback), stop(), displayTranslation(), hideOverlay(),
//   showOriginalSubtitles(), hideOriginalSubtitles(), getCurrentText(),
//   onSeek(callback)
const PrimeVideoSubtitles = (() => {
  let subtitleObserver = null;
  let bodyObserver = null;
  let lastSubtitleText = '';
  let lastObservedContainer = null;
  let onSubtitleChange = null;
  let onSeekCallback = null;
  let translationOverlay = null;
  let hideStyleEl = null;
  let hideTimeoutId = null;
  let seekDebounceId = null;

  const SUBTITLE_CONTAINER_SELECTORS = [
    '.atvwebplayersdk-captions-text',
    '[class*="captions-text"]',
    '.atvwebplayersdk-captions-overlay',
  ];

  function findSubtitleContainer() {
    for (const sel of SUBTITLE_CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function ensureHideStyle() {
    if (hideStyleEl && document.contains(hideStyleEl)) return;
    hideStyleEl = document.createElement('style');
    hideStyleEl.id = 'llm-hide-original-subs';
    document.head.appendChild(hideStyleEl);
  }

  function hideOriginalSubtitles() {
    ensureHideStyle();
    hideStyleEl.textContent = `
      .atvwebplayersdk-captions-text,
      [class*="captions-text"] {
        opacity: 0 !important;
      }
    `;
  }

  function showOriginalSubtitles() {
    if (hideStyleEl) {
      hideStyleEl.textContent = '';
    }
  }

  function getOrCreateOverlay() {
    if (translationOverlay && document.contains(translationOverlay)) {
      return translationOverlay;
    }

    translationOverlay = document.createElement('div');
    translationOverlay.id = 'llm-translation-overlay';
    document.body.appendChild(translationOverlay);
    return translationOverlay;
  }

  function start(callback) {
    onSubtitleChange = callback;
    ensureHideStyle();
    watchForSubtitleContainer();
  }

  function onSeek(callback) {
    onSeekCallback = callback;
  }

  function stop() {
    if (subtitleObserver) {
      subtitleObserver.disconnect();
      subtitleObserver = null;
    }
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
    if (hideTimeoutId) {
      clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }
    if (seekDebounceId) {
      clearTimeout(seekDebounceId);
      seekDebounceId = null;
    }
    if (translationOverlay) {
      translationOverlay.remove();
      translationOverlay = null;
    }
    if (hideStyleEl && document.contains(hideStyleEl)) {
      hideStyleEl.remove();
      hideStyleEl = null;
    }
    showOriginalSubtitles();
    lastSubtitleText = '';
    lastObservedContainer = null;
    onSubtitleChange = null;
    onSeekCallback = null;
  }

  function watchForSubtitleContainer() {
    const existing = findSubtitleContainer();
    if (existing) {
      observeSubtitles(existing);
    }

    bodyObserver = new MutationObserver(() => {
      const container = findSubtitleContainer();
      if (container && container !== lastObservedContainer) {
        observeSubtitles(container);
      }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function observeSubtitles(container) {
    if (subtitleObserver && lastObservedContainer === container) return;

    if (subtitleObserver) {
      subtitleObserver.disconnect();
    }

    lastObservedContainer = container;

    subtitleObserver = new MutationObserver(() => {
      processSubtitles(container);
    });

    subtitleObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    processSubtitles(container);
  }

  function processSubtitles(container) {
    let currentText = '';

    // Prime Video renders captions as spans within the captions-text container
    const allSpans = container.querySelectorAll('span');
    if (allSpans.length > 0) {
      allSpans.forEach((span) => {
        if (span.closest('#llm-translation-overlay')) return;
        if (span.querySelector('span')) return;
        if (span.textContent.trim()) {
          currentText += (currentText ? '\n' : '') + span.textContent.trim();
        }
      });
    }

    // Fallback: if no spans, try direct text content
    if (!currentText) {
      const text = container.textContent.trim();
      if (text) currentText = text;
    }

    if (currentText === lastSubtitleText) return;
    lastSubtitleText = currentText;

    if (!currentText) {
      hideOverlay();
      showOriginalSubtitles();
      if (onSeekCallback) {
        if (seekDebounceId) clearTimeout(seekDebounceId);
        seekDebounceId = setTimeout(() => {
          seekDebounceId = null;
          onSeekCallback();
        }, 2000);
      }
      return;
    }

    // New subtitle appeared — cancel any pending seek detection
    if (seekDebounceId) {
      clearTimeout(seekDebounceId);
      seekDebounceId = null;
    }

    if (onSubtitleChange) {
      onSubtitleChange(currentText, container);
    }
  }

  function displayTranslation(container, originalText, translatedText) {
    if (hideTimeoutId) {
      clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }

    const overlay = getOrCreateOverlay();

    overlay.innerHTML = '';
    overlay.classList.remove('llm-visible');

    const originalDiv = document.createElement('div');
    originalDiv.className = 'llm-original-line';
    originalDiv.textContent = originalText;

    const translatedDiv = document.createElement('div');
    translatedDiv.className = 'llm-translated-line';
    translatedDiv.textContent = translatedText;

    overlay.appendChild(originalDiv);
    overlay.appendChild(translatedDiv);

    overlay.style.display = 'flex';
    overlay.offsetHeight; // force layout
    overlay.classList.add('llm-visible');
    hideOriginalSubtitles();
  }

  function hideOverlay() {
    if (translationOverlay) {
      if (hideTimeoutId) {
        clearTimeout(hideTimeoutId);
      }
      translationOverlay.classList.remove('llm-visible');
      lastSubtitleText = '';
      hideTimeoutId = setTimeout(() => {
        if (translationOverlay && !translationOverlay.classList.contains('llm-visible')) {
          translationOverlay.style.display = 'none';
        }
        hideTimeoutId = null;
      }, 150);
    }
  }

  function getCurrentText() {
    return lastSubtitleText;
  }

  return {
    start, stop, onSeek,
    displayTranslation, hideOverlay,
    showOriginalSubtitles, hideOriginalSubtitles,
    getCurrentText,
  };
})();
