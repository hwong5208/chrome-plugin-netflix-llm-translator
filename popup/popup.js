const DEFAULT_SETTINGS = {
  enabled: true,
  learnMode: false,
  apiEndpoint: 'http://10.0.0.7:8000/v1/chat/completions',
  modelName: 'Qwen3.5-9B-MLX-4bit',
  apiKey: '',
  targetLanguage: 'Traditional Chinese',
  systemPrompt:
    'You are a subtitle translator. Translate the following subtitle text into {{targetLanguage}}. Output only the translation. Keep it natural and concise for subtitles. Do not add quotation marks, explanations, or annotations.',
  fontSize: '2.8vw',
  subtitleColor: '#ffffff',
};

const fields = [
  'enabled',
  'learnMode',
  'apiEndpoint',
  'modelName',
  'apiKey',
  'targetLanguage',
  'fontSize',
  'systemPrompt',
];

const PROMPT_PRESETS = {
  general:
    'You are a subtitle translator. Translate the following subtitle text into {{targetLanguage}}. Output only the translation. Keep it natural and concise for subtitles. Do not add quotation marks, explanations, or annotations.',
  anime:
    'You are a subtitle translator specializing in Japanese anime. Translate the following subtitle text into {{targetLanguage}}. Preserve Japanese honorifics (-san, -kun, -chan, -sama, -sensei, -senpai) in their original form. Adapt casual and slang speech naturally. Keep onomatopoeia expressive. Output only the translation. Do not add quotation marks, explanations, or annotations.',
  documentary:
    'You are a subtitle translator specializing in documentaries and educational content. Translate the following subtitle text into {{targetLanguage}}. Maintain precise technical terminology. Keep proper nouns, scientific names, and place names in their original form. Output only the translation. Do not add quotation marks, explanations, or annotations.',
};

const PRESET_LANGUAGES = [
  'Traditional Chinese', 'Simplified Chinese', 'Japanese',
  'Korean', 'Spanish', 'French', 'German', 'Portuguese',
];

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('verifyBtn').addEventListener('click', verifyService);
  document.getElementById('closeBtn').addEventListener('click', () => window.close());
  document.getElementById('clearCacheBtn').addEventListener('click', clearCache);

  // Toggles apply immediately without needing Save
  // Mutual exclusion: Dual Subtitles and Learn English cannot both be ON
  document.getElementById('enabled').addEventListener('change', () => {
    if (document.getElementById('enabled').checked) {
      document.getElementById('learnMode').checked = false;
    }
    saveSettings();
  });

  document.getElementById('learnMode').addEventListener('change', () => {
    if (document.getElementById('learnMode').checked) {
      document.getElementById('enabled').checked = false;
    }
    saveSettings();
  });

  const langSelect = document.getElementById('targetLanguage');
  const customInput = document.getElementById('customLanguage');
  langSelect.addEventListener('change', () => {
    customInput.classList.toggle('visible', langSelect.value === 'custom');
    if (langSelect.value !== 'custom') customInput.value = '';
  });

  // Preset chip click handlers
  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.preset-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const preset = chip.dataset.preset;
      document.getElementById('systemPrompt').value = PROMPT_PRESETS[preset];
    });
  });
});

function loadSettings() {
  chrome.storage.sync.get('llmTranslatorSettings', (result) => {
    const settings = { ...DEFAULT_SETTINGS, ...result.llmTranslatorSettings };

    for (const field of fields) {
      const el = document.getElementById(field);
      if (!el) continue;

      if (field === 'targetLanguage') {
        const langSelect = el;
        const customInput = document.getElementById('customLanguage');
        if (PRESET_LANGUAGES.includes(settings[field])) {
          langSelect.value = settings[field];
          customInput.classList.remove('visible');
        } else {
          langSelect.value = 'custom';
          customInput.value = settings[field];
          customInput.classList.add('visible');
        }
        continue;
      }

      if (el.type === 'checkbox') {
        el.checked = settings[field];
      } else {
        el.value = settings[field];
      }
    }

    // Highlight matching preset chip
    const savedPrompt = settings.systemPrompt;
    let matched = false;
    document.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.classList.remove('active');
      if (PROMPT_PRESETS[chip.dataset.preset] === savedPrompt) {
        chip.classList.add('active');
        matched = true;
      }
    });
    if (!matched) {
      // Custom prompt — no chip highlighted
    }
  });
}

function saveSettings() {
  const settings = {};

  for (const field of fields) {
    const el = document.getElementById(field);
    if (!el) continue;

    if (field === 'targetLanguage') {
      const langSelect = el;
      const customInput = document.getElementById('customLanguage');
      settings[field] = langSelect.value === 'custom'
        ? customInput.value.trim() || 'English'
        : langSelect.value;
      continue;
    }

    if (el.type === 'checkbox') {
      settings[field] = el.checked;
    } else {
      settings[field] = el.value.trim();
    }
  }

  chrome.storage.sync.set({ llmTranslatorSettings: settings }, () => {
    showStatus('Saved!', 'success');
  });
}

async function verifyService() {
  const btn = document.getElementById('verifyBtn');
  btn.disabled = true;

  const endpoint = document.getElementById('apiEndpoint').value.trim();
  const model = document.getElementById('modelName').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!endpoint) {
    showStatus('Please enter an API endpoint', 'error');
    btn.disabled = false;
    return;
  }

  showStatus('Connecting...', 'loading');
  const startTime = Date.now();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
      model: model || 'default',
      messages: [
        { role: 'system', content: 'Translate to Traditional Chinese. Output only the translation.' },
        { role: 'user', content: 'Hello' },
      ],
      temperature: 0,
      max_tokens: 32,
    };
    if (model && model.toLowerCase().includes('mlx')) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      showStatus(`HTTP ${response.status}: ${response.statusText}${text ? ' — ' + text.slice(0, 80) : ''}`, 'error');
      btn.disabled = false;
      return;
    }

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content?.trim();

    if (!translation) {
      showStatus('Connected but got empty response — check model name', 'error');
      btn.disabled = false;
      return;
    }

    // Clean thinking tags for display
    const clean = translation.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

    // Extract model and token stats from response
    const modelId = data.model || model || 'unknown';
    const usage = data.usage || {};
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const tokPerSec = completionTokens > 0 ? (completionTokens / (elapsed / 1000)).toFixed(1) : null;

    let info = `Model: ${modelId}\n"${clean}" (${elapsed}ms)`;
    if (tokPerSec) {
      info += `\n${completionTokens} tokens — ${tokPerSec} tok/s`;
    }
    showStatus(info, 'success');
  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
      showStatus('Cannot reach server — check endpoint URL and network', 'error');
    } else {
      showStatus(`Error: ${err.message}`, 'error');
    }
  }

  btn.disabled = false;
}

function clearCache() {
  // Cache lives in netflix.com's IndexedDB origin, not the extension's.
  // Send message to content script to clear it from the correct origin.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      showStatus('No active tab found', 'error');
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'clearCache' }, (resp) => {
      if (chrome.runtime.lastError) {
        showStatus('Open a Netflix or Prime Video tab first, then try again', 'error');
        return;
      }
      if (resp?.success) {
        showStatus('Cache cleared!', 'success');
      } else {
        showStatus('Failed to clear cache', 'error');
      }
    });
  });
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;

  if (type === 'success') {
    setTimeout(() => {
      status.textContent = '';
      status.className = 'status';
    }, 8000);
  }
}
