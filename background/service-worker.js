chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'translate') {
    handleTranslation(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'translateBatch') {
    handleBatchTranslation(message).then(sendResponse).catch((err) => {
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
    chat_template_kwargs: { enable_thinking: false },
  };

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
    max_tokens: texts.length * 100,
    chat_template_kwargs: { enable_thinking: false },
  };

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

  content = cleanTranslation(content);

  // Parse numbered responses: [1] translation, [2] translation, ...
  const translations = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < texts.length) {
        translations[texts[idx]] = match[2].trim();
      }
    }
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
