// Sends translation requests to the service worker.
// Handles both single and batch translations with dedup, timeout, and abort.
const Translator = (() => {
  const pendingRequests = new Map(); // key -> { promise, abort }
  const MESSAGE_TIMEOUT = 60000; // 60 seconds — needs headroom for slow LLM servers over network
  let abortController = new AbortController();

  // Abort all in-flight translation requests (e.g., on seek)
  function abortAll() {
    abortController.abort();
    abortController = new AbortController();
    pendingRequests.clear();
    console.log('[LLM Translator] Aborted all in-flight requests');
  }

  function _sendMessage(msg, signal) {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error('Translation request timeout (60s)'));
      }, MESSAGE_TIMEOUT);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(new Error('Request aborted'));
          return;
        }
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  async function translate(text, settings, context) {
    const key = text;
    // Dedup in-flight requests for the same text
    if (pendingRequests.has(key)) {
      return pendingRequests.get(key).promise;
    }

    const signal = abortController.signal;
    const promise = _sendMessage(
      { type: 'translate', text, settings, ...(context || {}) },
      signal
    ).then((resp) => {
      pendingRequests.delete(key);
      return resp.translation;
    }).catch((err) => {
      pendingRequests.delete(key);
      throw err;
    });

    pendingRequests.set(key, { promise });
    return promise;
  }

  async function translateBatch(texts, settings, context) {
    const signal = abortController.signal;
    const resp = await _sendMessage(
      { type: 'translateBatch', texts, settings, ...(context || {}) },
      signal
    );
    return resp.translations || {};
  }

  return { translate, translateBatch, abortAll };
})();
