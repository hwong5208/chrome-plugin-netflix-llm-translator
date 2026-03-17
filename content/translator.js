// Sends translation requests to the service worker
const Translator = (() => {
  const pendingRequests = new Map(); // text -> Promise
  const MESSAGE_TIMEOUT = 10000; // 10 seconds

  async function translate(text, settings) {
    // Dedup in-flight requests for the same text
    if (pendingRequests.has(text)) {
      return pendingRequests.get(text);
    }

    // Fix #7: Add timeout to prevent hanging promises if service worker dies
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(text);
        reject(new Error('Translation request timeout (10s)'));
      }, MESSAGE_TIMEOUT);

      chrome.runtime.sendMessage(
        { type: 'translate', text, settings },
        (response) => {
          clearTimeout(timer);
          pendingRequests.delete(text);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response.translation);
        }
      );
    });

    pendingRequests.set(text, promise);
    return promise;
  }

  return { translate };
})();
