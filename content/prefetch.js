// Runs in MAIN world (page context) to intercept Netflix subtitle file downloads.
// Checks ALL XHR/fetch responses for TTML/WebVTT content (not just URL matching).
(() => {
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._llmUrl = typeof url === 'string' ? url : url?.toString?.() || '';
    return originalXHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const text = this.responseText || '';
        if (!text || text.length < 50) return;
        tryParseSubtitles(text);
      } catch (e) {}
    });
    return originalXHRSend.call(this, ...args);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);

    try {
      const contentType = response.headers?.get('content-type') || '';
      // Only try text-based responses
      if (
        contentType.includes('xml') ||
        contentType.includes('text') ||
        contentType.includes('ttml') ||
        contentType.includes('vtt') ||
        contentType.includes('dfxp')
      ) {
        const cloned = response.clone();
        const text = await cloned.text();
        tryParseSubtitles(text);
      }
    } catch (e) {}

    return response;
  };

  // Fix #9: Global dedup to prevent re-posting cues from reloaded subtitle files
  const globalSeen = new Set();
  const MAX_GLOBAL_SEEN = 5000;

  function tryParseSubtitles(text) {
    let cues = [];

    if (text.includes('<tt') && text.includes('<p')) {
      cues = parseTTML(text);
    } else if (text.trimStart().startsWith('WEBVTT')) {
      cues = parseWebVTT(text);
    }

    // Filter out globally seen cues, cap Set size to prevent memory leak
    const newCues = cues.filter((c) => !globalSeen.has(c));
    for (const c of newCues) {
      if (globalSeen.size >= MAX_GLOBAL_SEEN) {
        // Evict oldest entry
        const first = globalSeen.values().next().value;
        globalSeen.delete(first);
      }
      globalSeen.add(c);
    }

    if (newCues.length > 0) {
      console.log(`[LLM Prefetch] Found ${newCues.length} new subtitle cues`);
      window.postMessage({ type: 'LLM_SUBTITLE_CUES', cues: newCues }, '*');
    }
  }

  function parseTTML(xmlText) {
    const cues = [];
    const seen = new Set();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const paragraphs = doc.querySelectorAll('p');

    paragraphs.forEach((p) => {
      let text = '';
      p.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeName === 'br') {
          text += '\n';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          text += node.textContent;
        }
      });
      text = text.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        cues.push(text);
      }
    });

    return cues;
  }

  function parseWebVTT(vttText) {
    const cues = [];
    const seen = new Set();
    const lines = vttText.split('\n');
    let inCue = false;
    let cueText = '';

    for (const line of lines) {
      if (line.includes('-->')) {
        inCue = true;
        cueText = '';
      } else if (inCue) {
        if (line.trim() === '') {
          const text = cueText.trim();
          if (text && !seen.has(text)) {
            seen.add(text);
            cues.push(text);
          }
          inCue = false;
          cueText = '';
        } else {
          cueText += (cueText ? '\n' : '') + line.replace(/<[^>]+>/g, '').trim();
        }
      }
    }
    const text = cueText.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      cues.push(text);
    }

    return cues;
  }
})();
