// Adaptive throughput controller with circuit breaker
// Dynamically adjusts batch size and worker count based on observed
// LLM response times. Includes circuit breaker to stop hammering
// a dead server.
const Adaptive = (() => {
  const state = {
    batchSize: 5,
    concurrency: 2,
    activeRequests: 0,
    MIN_BATCH: 2,
    MAX_BATCH: 15,
    MIN_WORKERS: 1,
    MAX_WORKERS: 5,
    latencies: [],
    WINDOW: 8,
    errors: 0,
    cooldown: 0,
    COOLDOWN_PERIOD: 4,
    FAST_MS: 2000,
    SLOW_MS: 6000,

    // Circuit breaker state
    CIRCUIT_THRESHOLD: 5,    // consecutive failures to trip
    CIRCUIT_COOLDOWN: 30000, // 30s before probe
    circuitOpen: false,
    circuitOpenedAt: 0,
  };

  function record(latencyMs, success) {
    if (!success) {
      state.errors++;
      scaleDown();
      // Trip circuit breaker after threshold consecutive failures
      if (state.errors >= state.CIRCUIT_THRESHOLD && !state.circuitOpen) {
        state.circuitOpen = true;
        state.circuitOpenedAt = Date.now();
        console.warn(`[LLM Circuit] OPEN — ${state.errors} consecutive failures, pausing for ${state.CIRCUIT_COOLDOWN / 1000}s`);
      }
      return;
    }
    // Success — reset error count and close circuit
    state.errors = 0;
    if (state.circuitOpen) {
      state.circuitOpen = false;
      console.log('[LLM Circuit] CLOSED — server recovered');
    }
    state.latencies.push(latencyMs);
    if (state.latencies.length > state.WINDOW) state.latencies.shift();
    adjust();
  }

  function avgLatency() {
    if (state.latencies.length === 0) return state.SLOW_MS;
    return state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length;
  }

  function adjust() {
    if (state.latencies.length < 3) return;
    if (state.cooldown > 0) { state.cooldown--; return; }
    const avg = avgLatency();
    if (avg < state.FAST_MS) {
      scaleUp();
    } else if (avg > state.SLOW_MS) {
      scaleDown();
    }
  }

  function scaleUp() {
    const oldB = state.batchSize, oldW = state.concurrency;
    state.batchSize = Math.min(state.batchSize + 2, state.MAX_BATCH);
    state.concurrency = Math.min(state.concurrency + 1, state.MAX_WORKERS);
    if (state.batchSize !== oldB || state.concurrency !== oldW) {
      state.cooldown = state.COOLDOWN_PERIOD;
      console.log(`[LLM Adaptive] Scale UP → batch=${state.batchSize} workers=${state.concurrency} (avg ${Math.round(avgLatency())}ms)`);
    }
  }

  function scaleDown() {
    const oldB = state.batchSize, oldW = state.concurrency;
    state.batchSize = Math.max(Math.floor(state.batchSize * 0.6), state.MIN_BATCH);
    state.concurrency = Math.max(state.concurrency - 1, state.MIN_WORKERS);
    if (state.batchSize !== oldB || state.concurrency !== oldW) {
      state.cooldown = state.COOLDOWN_PERIOD;
      console.log(`[LLM Adaptive] Scale DOWN → batch=${state.batchSize} workers=${state.concurrency} (avg ${Math.round(avgLatency())}ms, errors=${state.errors})`);
    }
  }

  // Circuit breaker check — returns true if requests should be blocked
  function isCircuitOpen() {
    if (!state.circuitOpen) return false;
    // Allow a probe after cooldown
    if (Date.now() - state.circuitOpenedAt >= state.CIRCUIT_COOLDOWN) {
      console.log('[LLM Circuit] HALF-OPEN — allowing probe request');
      return false; // allow one probe through
    }
    return true;
  }

  function getBatchSize() { return state.batchSize; }
  function getConcurrency() { return state.concurrency; }
  function getActiveRequests() { return state.activeRequests; }
  function incrementActive() { state.activeRequests++; }
  function decrementActive() { state.activeRequests--; }

  // Check if adding more load would exceed adaptive target
  function shouldThrottle() {
    return state.activeRequests >= state.concurrency + 1;
  }

  return {
    record, getBatchSize, getConcurrency, getActiveRequests,
    incrementActive, decrementActive, isCircuitOpen, shouldThrottle,
  };
})();
