# Local LLM Subtitle Translator

A Chrome extension that translates Netflix subtitles in real-time using a local LLM via any
OpenAI-compatible API endpoint. Bilingual subtitles are rendered in an overlay styled to match
Netflix's native subtitle UI — seamless enough that it looks built-in. Powered by your own
hardware — no cloud, no subscription, no data leaves your network.

---

## Demo

### Bilingual Subtitles

![Netflix player showing original English and translated Traditional Chinese subtitles — One Piece](docs/Netflix_dual_sub.JPG)

### Settings Panel

![Extension popup with dark theme, genre preset chips, and language selector](docs/Chrome_plugin_UI.JPG)

---

## Features

- **Real-time translation** — subtitles translated and displayed as they appear
- **Prefetch pipeline** — intercepts subtitle files at download time, batch-translates before playback
- **Two-tier cache** — L1 in-memory (instant) + L2 IndexedDB (persists across sessions)
- **3-worker parallelism** — concurrent batch translation with lookahead for next 5 cues
- **Smooth transitions** — 150ms opacity fade-in/out, no subtitle flicker
- **Genre prompt presets** — one-click prompts for General, Anime, and Documentary
- **8 languages built-in** — dropdown with top languages + custom option
- **Any OpenAI-compatible API** — works with MLX, vLLM, Ollama, llama.cpp, LM Studio, etc.
- **Fully local** — all translation stays on your LAN

---

## Architecture

```
Netflix Page (DOM)
      │
      ├── [prefetch.js]  ← intercepts XHR/Fetch, parses TTML & WebVTT
      │         │
      │         ▼
      │   [content.js]   ← orchestrator: queue → dedup → batch → cache
      │         │
      │         ├── [cache.js]       ← L1 Map (500 LRU) + L2 IndexedDB
      │         ├── [translator.js]  ← dedup in-flight, message passing
      │         └── [netflix.js]     ← MutationObserver + overlay display
      │
      ▼
[service-worker.js]      ← routes API calls (avoids CORS)
      │
      ▼
Local LLM Server         ← OpenAI-compatible /v1/chat/completions
(MLX / vLLM / Ollama)
```

### Key Design Decisions

**Prefetch at intercept** — `prefetch.js` runs in the `MAIN` world at `document_start`, monkey-patching
`XMLHttpRequest` and `fetch` to capture subtitle payloads before Netflix even renders them. This gives
the extension a head start of several seconds to batch-translate upcoming cues.

**Two-tier cache** — The L1 memory cache provides synchronous, zero-cost lookups on the hot path.
L2 IndexedDB persists translations across page reloads and browser restarts, so re-watching an episode
hits cache for every line.

**Batch + parallel workers** — Subtitles are grouped into batches of 10 and processed by 3 concurrent
workers. A single batch request is far cheaper than 10 individual requests because it amortizes the
network RTT and LLM prefill cost across all lines.

**Lookahead** — Every time a subtitle is displayed, the extension fires off a background translation
for the next 5 uncached cues. Combined with prefetch, this means cache misses in normal playback are
near zero.

**Service worker for CORS** — Content scripts cannot call a local LLM server directly due to browser
CORS restrictions. The background service worker acts as a proxy, making the `fetch()` call from the
extension context where CORS does not apply.

---

## Project Structure

```
local-llm-translator/
├── manifest.json                # Manifest V3 config
├── background/
│   └── service-worker.js        # Translation API proxy (single + batch)
├── content/
│   ├── prefetch.js              # XHR/Fetch intercept, TTML & WebVTT parsing
│   ├── content.js               # Orchestrator: settings, prefetch queue, lookahead
│   ├── netflix.js               # MutationObserver + bilingual overlay
│   ├── translator.js            # In-flight dedup + message passing to SW
│   └── cache.js                 # L1 Map (LRU) + L2 IndexedDB
├── popup/
│   ├── popup.html               # Settings UI
│   ├── popup.js                 # Save/load settings, verify service
│   └── popup.css                # Dark theme (emerald green / deep navy)
├── styles/
│   └── subtitle.css             # Translation overlay styling + transitions
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `local-llm-translator/` folder
5. Pin the extension to the toolbar

---

## Configuration

Click the extension icon to open the settings popup.

| Setting          | Default                                     | Description                                      |
| ---------------- | ------------------------------------------- | ------------------------------------------------ |
| Enabled          | `true`                                      | Toggle translation on/off                        |
| API Endpoint     | `http://10.0.0.7:8000/v1/chat/completions`  | OpenAI-compatible completions URL                |
| Model            | `Qwen3.5-9B-MLX-4bit`                       | Model name sent in API request                   |
| API Key          | _(empty)_                                   | Optional Bearer token                            |
| Translate To     | `Traditional Chinese`                       | Dropdown with 8 languages + custom option        |
| Font Size        | `2.8vw`                                     | CSS font size for translated subtitles           |
| Prompt Preset    | `General`                                   | One-click genre prompts: General, Anime, Documentary |
| System Prompt    | _(auto-filled by preset)_                   | Editable, supports `{{targetLanguage}}` variable |

Use **Verify Service** to test connectivity — it shows the model name, a sample translation,
response latency, and token throughput (tok/s).

---

## Supported LLM Servers

Any server exposing an OpenAI-compatible `/v1/chat/completions` endpoint:

| Server                                                            | Example Endpoint                          |
| ----------------------------------------------------------------- | ----------------------------------------- |
| [MLX LM Server](https://github.com/ml-explore/mlx-lm)            | `http://localhost:8000/v1/chat/completions`|
| [vLLM](https://github.com/vllm-project/vllm)                     | `http://localhost:8000/v1/chat/completions`|
| [Ollama](https://ollama.com)                                      | `http://localhost:11434/v1/chat/completions`|
| [llama.cpp server](https://github.com/ggml-org/llama.cpp)         | `http://localhost:8080/v1/chat/completions`|
| [LM Studio](https://lmstudio.ai)                                  | `http://localhost:1234/v1/chat/completions`|

---

## How It Works

1. **Intercept** — `prefetch.js` captures Netflix subtitle file downloads (TTML/WebVTT) via
   XHR/Fetch monkey-patching and extracts all cue text
2. **Queue** — `content.js` deduplicates cues against both cache tiers and enqueues uncached ones
3. **Batch translate** — 3 parallel workers send batches of 10 to the service worker, which calls
   the LLM with a numbered format (`[1] Hello \n [2] Goodbye`) for efficient single-request translation
4. **Cache** — Translations are stored in both L1 (memory) and L2 (IndexedDB)
5. **Display** — When Netflix renders a subtitle, `netflix.js` detects it via MutationObserver,
   `content.js` checks cache (instant hit), and the bilingual overlay fades in within 150ms
6. **Lookahead** — Each displayed subtitle triggers background translation of the next 5 uncached cues

---

## Future Improvements

- **Multi-platform support** — Extend subtitle detection to YouTube, Disney+, and Prime Video
- **Streaming translation** — Use SSE/streaming API responses to display partial translations as they generate
- **Subtitle timing sync** — Map translated cues to Netflix's internal timing data for frame-perfect display
- **Translation memory** — Export/import cached translations for sharing across devices
- **Model auto-detection** — Query `/v1/models` endpoint to auto-populate the model selector

---

## Tools Used

- [Claude Code](https://claude.ai/code) — AI coding assistant used throughout development
