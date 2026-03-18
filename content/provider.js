// Platform detection — returns the correct SubtitleProvider for the current site.
const SubtitleProvider = (() => {
  function detect() {
    const host = window.location.hostname;

    if (host.includes('netflix.com')) {
      return NetflixSubtitles;
    }

    if (host.includes('amazon.com') || host.includes('primevideo.com')) {
      return PrimeVideoSubtitles;
    }

    console.warn('[LLM Translator] Unknown platform:', host);
    return null;
  }

  return { detect };
})();
