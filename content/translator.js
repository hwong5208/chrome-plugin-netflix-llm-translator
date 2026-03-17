// Sends translation requests to the service worker
const Translator = (() => {
  const pendingRequests = new Map(); // text -> Promise

  async function translate(text, settings) {
    // Dedup in-flight requests for the same text
    if (pendingRequests.has(text)) {
      return pendingRequests.get(text);
    }

    const promise = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'translate', text, settings },
        (response) => {
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
