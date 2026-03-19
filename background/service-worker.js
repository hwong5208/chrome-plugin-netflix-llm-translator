// Keep service worker alive during long-running operations (MV3 workaround).
// Chrome kills service workers after ~30s of inactivity. This extends the
// lifetime by pinging chrome.runtime periodically during active work.
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'translate') {
    handleTranslation(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'translateBatch') {
    startKeepAlive();
    handleBatchTranslation(message).then((r) => {
      stopKeepAlive();
      sendResponse(r);
    }).catch((err) => {
      stopKeepAlive();
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'explainWord') {
    handleWordExplanation(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'explainWordBatch') {
    handleWordBatchExplanation(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'getSettings') {
    chrome.storage.sync.get('llmTranslatorSettings', (result) => {
      sendResponse(result.llmTranslatorSettings || null);
    });
    return true;
  }
});

function cleanTranslation(text) {
  // Strip thinking tags if present (Qwen3.5 thinking mode)
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  // Strip common LLM preambles
  text = text
    .replace(/^(Translation|翻[译譯]|Here'?s?\s*(the\s*)?translation):?\s*/i, '')
    .trim();
  return text;
}

function buildHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// Single subtitle translation
async function handleTranslation({ text, settings }) {
  const resolvedSystemPrompt = settings.systemPrompt.replace(
    /\{\{targetLanguage\}\}/g,
    settings.targetLanguage
  );

  const body = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: resolvedSystemPrompt },
      { role: 'user', content: text },
    ],
    temperature: 0,
    max_tokens: 256,
  };
  // Only include MLX-specific field for MLX models
  if (settings.modelName && settings.modelName.toLowerCase().includes('mlx')) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(settings.apiEndpoint, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  let translation = data.choices?.[0]?.message?.content?.trim();

  if (!translation) {
    throw new Error('Empty translation response');
  }

  return { translation: cleanTranslation(translation) };
}

// Batch subtitle translation — multiple subtitles in ONE LLM request
async function handleBatchTranslation({ texts, settings }) {
  const resolvedSystemPrompt = settings.systemPrompt.replace(
    /\{\{targetLanguage\}\}/g,
    settings.targetLanguage
  );

  // Build a numbered list for the LLM to translate
  const numberedInput = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  const body = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: resolvedSystemPrompt },
      { role: 'user', content: `Translate each numbered line. Return ONLY translations in the same [1], [2], ... format, one per line:\n\n${numberedInput}` },
    ],
    temperature: 0,
    max_tokens: Math.max(texts.length * 100, 256),
  };
  if (settings.modelName && settings.modelName.toLowerCase().includes('mlx')) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(settings.apiEndpoint, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Empty batch translation response');
  }

  // Detect if response was truncated by token limit
  const finishReason = data.choices?.[0]?.finish_reason;
  const wasTruncated = finishReason === 'length';

  content = cleanTranslation(content);

  // Parse numbered responses: [1] translation, [2] translation, ...
  const translations = {};
  const lines = content.split('\n');
  let lastParsedIdx = -1;
  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < texts.length) {
        translations[texts[idx]] = match[2].trim();
        lastParsedIdx = idx;
      }
    }
  }

  // If truncated by max_tokens, the last parsed entry may be incomplete — discard it
  if (wasTruncated && lastParsedIdx >= 0) {
    const lastText = texts[lastParsedIdx];
    delete translations[lastText];
    console.warn(`[LLM Translator] Batch truncated at [${lastParsedIdx + 1}], will retry individually`);
  }

  // Fix #8: Retry missing translations individually
  const missing = texts.filter((t) => !translations[t]);
  if (missing.length > 0) {
    console.warn(
      `[LLM Translator] Batch: ${missing.length}/${texts.length} missing, retrying individually`
    );
    for (const text of missing) {
      try {
        const result = await handleTranslation({ text, settings });
        translations[text] = result.translation;
      } catch (e) {
        console.warn(`[LLM Translator] Individual retry failed for: "${text.slice(0, 40)}..."`);
      }
    }
  }

  return { translations };
}

// Word explanation for Learn English mode
async function handleWordExplanation({ word, sentence, settings }) {
  const lang = settings.targetLanguage;

  const body = {
    model: settings.modelName,
    messages: [
      {
        role: 'system',
        content: `You are a concise English vocabulary tutor for ${lang} speakers. When given a word and its sentence context, reply in exactly this format:\nTranslation: <${lang} meaning>\nPronunciation: <IPA>\nType: <part of speech>\nContext: <one brief sentence in ${lang} explaining the meaning in this context>`,
      },
      {
        role: 'user',
        content: `Word: "${word}"\nSentence: "${sentence}"`,
      },
    ],
    temperature: 0,
    max_tokens: 128,
  };
  if (settings.modelName?.toLowerCase().includes('mlx')) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(settings.apiEndpoint, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response');

  content = cleanTranslation(content);

  // Parse structured response
  const result = {};
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  return { explanation: result };
}

// Batch word explanation — all words from a subtitle in ONE LLM request
async function handleWordBatchExplanation({ words, sentence, settings }) {
  const lang = settings.targetLanguage;

  const wordList = words.map((w, i) => `[${i + 1}] ${w}`).join('\n');

  const body = {
    model: settings.modelName,
    messages: [
      {
        role: 'system',
        content: `You are a concise English vocabulary tutor for ${lang} speakers. You will be given a list of English words from a subtitle sentence. For each word, provide a brief explanation in this exact numbered format:

[1] word
Translation: <${lang} meaning>
Pronunciation: <IPA>
Type: <part of speech>
Context: <one brief sentence in ${lang} explaining the meaning in this context>

[2] word
...

Be concise. Do not skip any word.`,
      },
      {
        role: 'user',
        content: `Sentence: "${sentence}"\n\nWords:\n${wordList}`,
      },
    ],
    temperature: 0,
    max_tokens: Math.max(words.length * 80, 256),
  };
  if (settings.modelName?.toLowerCase().includes('mlx')) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(settings.apiEndpoint, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response');

  content = cleanTranslation(content);

  // Parse batch response: [N] word\nTranslation: ...\nPronunciation: ...\nType: ...\nContext: ...
  const explanations = {};
  const blocks = content.split(/\n(?=\[\d+\])/);
  for (const block of blocks) {
    const headerMatch = block.match(/^\[(\d+)\]\s*(.+)/);
    if (!headerMatch) continue;
    const idx = parseInt(headerMatch[1]) - 1;
    if (idx < 0 || idx >= words.length) continue;

    const wordKey = words[idx];
    const result = {};
    const lines = block.split('\n').slice(1); // skip the [N] header line
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        result[key] = value;
      }
    }
    if (Object.keys(result).length > 0) {
      explanations[wordKey] = result;
    }
  }

  return { explanations };
}
