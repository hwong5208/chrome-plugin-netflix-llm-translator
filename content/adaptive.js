// Fixed throughput controller with circuit breaker.
// Hardcoded batch=2, workers=1 — no dynamic scaling for now.
const Adaptive = (() => {
  const state = {
    batchSize: 2,
    concurrency: 1,
    activeRequests: 0,
    errors: 0,

    // Circuit breaker state
    CIRCUIT_THRESHOLD: 5,    // consecutive failures to trip
    CIRCUIT_COOLDOWN: 30000, // 30s before probe
    circuitOpen: false,
    circuitOpenedAt: 0,
  };

  function record(_latencyMs, success) {
    if (!success) {
      state.errors++;
      if (state.errors >= state.CIRCUIT_THRESHOLD && !state.circuitOpen) {
        state.circuitOpen = true;
        state.circuitOpenedAt = Date.now();
        console.warn(`[LLM Circuit] OPEN — ${state.errors} consecutive failures, pausing for ${state.CIRCUIT_COOLDOWN / 1000}s`);
      }
      return;
    }
    state.errors = 0;
    if (state.circuitOpen) {
      state.circuitOpen = false;
      console.log('[LLM Circuit] CLOSED — server recovered');
    }
  }

  function isCircuitOpen() {
    if (!state.circuitOpen) return false;
    if (Date.now() - state.circuitOpenedAt >= state.CIRCUIT_COOLDOWN) {
      console.log('[LLM Circuit] HALF-OPEN — allowing probe request');
      return false;
    }
    return true;
  }

  function getBatchSize() { return state.batchSize; }
  function getConcurrency() { return state.concurrency; }
  function getActiveRequests() { return state.activeRequests; }
  function incrementActive() { state.activeRequests++; }
  function decrementActive() { state.activeRequests--; }

  function shouldThrottle() {
    return state.activeRequests >= state.concurrency + 1;
  }

  return {
    record, getBatchSize, getConcurrency, getActiveRequests,
    incrementActive, decrementActive, isCircuitOpen, shouldThrottle,
  };
})();
