// Netflix subtitle detection and injection
const NetflixSubtitles = (() => {
  let subtitleObserver = null;
  let bodyObserver = null;
  let lastSubtitleText = '';
  let lastObservedContainer = null;
  let onSubtitleChange = null;
  let translationOverlay = null;
  let hideStyleEl = null;
  let hideTimeoutId = null;

  const SUBTITLE_CONTAINER_SELECTORS = [
    '.player-timedtext',
    '[data-uia="player-timedtext"]',
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
      .player-timedtext {
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
    if (translationOverlay) {
      translationOverlay.remove();
      translationOverlay = null;
    }
    // Remove hide style so Netflix originals are visible after stop
    if (hideStyleEl && document.contains(hideStyleEl)) {
      hideStyleEl.remove();
      hideStyleEl = null;
    }
    showOriginalSubtitles();
    lastSubtitleText = '';
    lastObservedContainer = null;
    onSubtitleChange = null;
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

  // Fix #3: Track lastObservedContainer to prevent observer leak
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

    const allSpans = container.querySelectorAll('span');
    allSpans.forEach((span) => {
      if (span.closest('#llm-translation-overlay')) return;
      if (span.querySelector('span')) return;
      if (span.textContent.trim()) {
        currentText += (currentText ? '\n' : '') + span.textContent.trim();
      }
    });

    // Dedup: skip if same text still on screen.
    // Backward seek is handled by hideOverlay() resetting lastSubtitleText to ''.
    if (currentText === lastSubtitleText) return;
    lastSubtitleText = currentText;

    if (!currentText) {
      // Subtitle cleared — fade out and hide
      hideOverlay();
      showOriginalSubtitles();
      return;
    }

    // Don't hide original yet — let content.js decide based on cache hit
    if (onSubtitleChange) {
      onSubtitleChange(currentText, container);
    }
  }

  // Called when translation is ready — smooth fade-in swap
  function displayTranslation(container, originalText, translatedText) {
    // Fix #2: Cancel any pending hide timeout
    if (hideTimeoutId) {
      clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }

    const overlay = getOrCreateOverlay();

    // Build new content off-screen, then swap with transition
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

    // Force reflow then trigger fade-in
    overlay.style.display = 'flex';
    overlay.offsetHeight; // force layout
    overlay.classList.add('llm-visible');
    hideOriginalSubtitles();
  }

  // Fix #2: Track timeout ID, prevent stale timeouts from hiding new content
  function hideOverlay() {
    if (translationOverlay) {
      if (hideTimeoutId) {
        clearTimeout(hideTimeoutId);
      }
      translationOverlay.classList.remove('llm-visible');
      // Reset lastSubtitleText so re-appearing text is treated as new (Fix #1)
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

  return { start, stop, displayTranslation, hideOverlay, showOriginalSubtitles, hideOriginalSubtitles, getCurrentText };
})();
