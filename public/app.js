'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  sentences:    [],
  articleText:  '',
  articleTitle: '',
  chatHistory:  [],
  targetLang:   'zh',
  view:         'welcome'
};

// ─── LLM Config (persisted in localStorage) ───────────────────────────────────

const LLM_PRESETS = {
  anthropic: { type: 'anthropic', baseUrl: '',                                   model: 'claude-haiku-4-5-20251001',     label: 'Anthropic' },
  openai:    { type: 'openai',    baseUrl: 'https://api.openai.com/v1',           model: 'gpt-4o-mini',                   label: 'OpenAI'    },
  ollama:    { type: 'openai',    baseUrl: 'http://localhost:11434/v1',            model: 'qwen2.5:7b',                    label: 'Ollama'    },
  deepseek:  { type: 'openai',    baseUrl: 'https://api.deepseek.com/v1',         model: 'deepseek-chat',                 label: 'DeepSeek'  },
  groq:      { type: 'openai',    baseUrl: 'https://api.groq.com/openai/v1',      model: 'llama-3.3-70b-versatile',       label: 'Groq'      },
  custom:    { type: 'openai',    baseUrl: '',                                    model: '',                              label: '自定义'    },
};

let llmConfig = {
  type:    'anthropic',
  baseUrl: '',
  apiKey:  '',
  model:   'claude-haiku-4-5-20251001',
};
try {
  const saved = localStorage.getItem('llmConfig');
  if (saved) llmConfig = { ...llmConfig, ...JSON.parse(saved) };
} catch {}

function saveLlmConfig() {
  localStorage.setItem('llmConfig', JSON.stringify(llmConfig));
}

// ─── LLM History (persisted in localStorage) ─────────────────────────────────

let llmHistory = [];
try {
  const h = localStorage.getItem('llmHistory');
  if (h) llmHistory = JSON.parse(h);
} catch {}

function inferProvider(config) {
  if (config.type === 'anthropic') return 'Anthropic';
  const url = (config.baseUrl || '').toLowerCase();
  if (url.includes('11434') || url.includes('ollama')) return 'Ollama';
  if (url.includes('deepseek'))  return 'DeepSeek';
  if (url.includes('groq'))      return 'Groq';
  if (url.includes('openai.com')) return 'OpenAI';
  if (url.includes('localhost') || url.includes('127.0.0.1')) return '本地';
  return '自定义';
}

function saveToHistory(config) {
  if (!config.model && config.type !== 'anthropic') return;
  const key = `${config.type}|${config.baseUrl}|${config.model}`;
  llmHistory = llmHistory.filter(h => `${h.type}|${h.baseUrl}|${h.model}` !== key);
  const provider = inferProvider(config);
  const label = config.model ? `${provider} / ${config.model}` : provider;
  llmHistory.unshift({
    id: Date.now().toString(), label,
    type: config.type, baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '', model: config.model || ''
  });
  if (llmHistory.length > 10) llmHistory = llmHistory.slice(0, 10);
  localStorage.setItem('llmHistory', JSON.stringify(llmHistory));
}

function renderHistoryList() {
  const list    = document.getElementById('llmHistoryList');
  const section = document.getElementById('historySection');
  if (!list || !section) return;
  if (!llmHistory.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  const curKey = `${llmConfig.type}|${llmConfig.baseUrl}|${llmConfig.model}`;
  list.innerHTML = llmHistory.map(h => {
    const active = `${h.type}|${h.baseUrl}|${h.model}` === curKey;
    return `<div class="history-item${active ? ' active' : ''}" data-id="${h.id}">
      <span class="history-label">${escHtml(h.label)}</span>
      <span class="history-del" data-del="${h.id}" title="删除">✕</span>
    </div>`;
  }).join('');
}

// ─── Chat TTS / Voice-input state ────────────────────────────────────────────

let autoReadChat = localStorage.getItem('autoReadChat') !== 'false';  // default true
let micLang      = localStorage.getItem('micLang') || 'zh-CN';        // 'zh-CN' | 'ja-JP'
let chatTtsUtter = null;    // current chat TTS utterance

function speakChatText(text) {
  if (typeof speechSynthesis === 'undefined') return;
  if (chatTtsUtter) { speechSynthesis.cancel(); chatTtsUtter = null; }
  // Strip markdown syntax before speaking
  const plain = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\n{2,}/g, '。');
  const u = new SpeechSynthesisUtterance(plain);
  // Use Chinese voice for AI responses (mostly Chinese text with some Japanese)
  u.lang = state.targetLang === 'en' ? 'en-US' : 'zh-CN';
  u.rate = 1.0;
  u.onend = () => { chatTtsUtter = null; };
  chatTtsUtter = u;
  speechSynthesis.speak(u);
}

function stopChatTts() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  chatTtsUtter = null;
}

// ─── TTS Controller ───────────────────────────────────────────────────────────

const tts = {
  isPlaying:     false,
  isPaused:      false,
  currentIdx:    0,
  rate:          1.0,
  jaVoice:       null,
  mode:          'webspeech',   // 'server' (voicevox/edge) | 'webspeech'
  speakerId:     3,
  _audioCache:   new Map(),     // idx -> objectURL (prefetched)
  _currentAudio: null,

  get sentences() { return state.sentences; },

  play() {
    if (!this.sentences.length) return;
    this.isPlaying = true;
    this.isPaused  = false;
    this._playAt(this.currentIdx);
    updatePlayBtn();
  },

  pause() {
    this.isPlaying = false;
    this.isPaused  = true;
    this._cancelCurrent();
    updatePlayBtn();
  },

  toggle() { this.isPlaying ? this.pause() : this.play(); },

  prev() {
    this._cancelCurrent();
    this.currentIdx = Math.max(0, this.currentIdx - 1);
    highlightSentence(this.currentIdx);
    updateProgress();
    if (this.isPlaying) this._playAt(this.currentIdx);
  },

  next() {
    this._cancelCurrent();
    this.currentIdx = Math.min(this.sentences.length - 1, this.currentIdx + 1);
    highlightSentence(this.currentIdx);
    updateProgress();
    if (this.isPlaying) this._playAt(this.currentIdx);
  },

  jumpTo(idx) {
    this._cancelCurrent();
    this.currentIdx = idx;
    highlightSentence(idx);
    updateProgress();
    if (this.isPlaying) this._playAt(idx);
  },

  setRate(r) {
    this.rate = r;
    if (this.mode === 'server') {
      this._audioCache.forEach(url => URL.revokeObjectURL(url));
      this._audioCache.clear();
    }
    if (this.isPlaying) {
      this._cancelCurrent();
      this._playAt(this.currentIdx);
    }
  },

  _cancelCurrent() {
    speechSynthesis.cancel();  // always stop Web Speech regardless of mode
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio = null;
    }
    this._audioCache.forEach(url => URL.revokeObjectURL(url));
    this._audioCache.clear();
  },

  async _prefetch(idx) {
    if (this.mode !== 'server') return;
    if (idx >= this.sentences.length || this._audioCache.has(idx)) return;
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: this.sentences[idx].plain, speakerId: this.speakerId, voice: this.speakerId, speed: this.rate })
      });
      if (!res.ok) return;
      this._audioCache.set(idx, URL.createObjectURL(await res.blob()));
    } catch { /* prefetch failure is non-fatal */ }
  },

  _playAt(idx) {
    this.mode === 'server' ? this._playVoicevoxAt(idx) : this._playWebSpeechAt(idx);
  },

  // ── VOICEVOX playback ─────────────────────────────────────────────────────
  async _playVoicevoxAt(idx) {
    if (idx >= this.sentences.length) {
      this.isPlaying  = false;
      this.currentIdx = 0;
      clearHighlight();
      updatePlayBtn();
      updateProgress();
      return;
    }

    this.currentIdx = idx;
    highlightSentence(idx);
    updateProgress();
    this._prefetch(idx + 1);  // non-blocking lookahead

    try {
      let audioUrl = this._audioCache.get(idx);
      if (!audioUrl) {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: this.sentences[idx].plain, speakerId: this.speakerId, voice: this.speakerId, speed: this.rate })
        });
        if (!res.ok) {
          this._failCount = (this._failCount || 0) + 1;
          if (this._failCount >= 3) {
            console.warn('Server TTS failed 3x, switching to Web Speech');
            this.mode = 'webspeech';
            this._failCount = 0;
            loadVoices();
            showMessage('语音服务连接失败，已切换到系统语音', 'warn');
            if (this.isPlaying) this._playWebSpeechAt(idx);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        this._failCount = 0;
        audioUrl = URL.createObjectURL(await res.blob());
      }

      const audio = new Audio(audioUrl);
      this._currentAudio = audio;

      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('audio error'));
        audio.play().catch(reject);
      });

      URL.revokeObjectURL(audioUrl);
      this._audioCache.delete(idx);
      this._currentAudio = null;

      if (this.isPlaying && !this.isPaused) this._playAt(idx + 1);
    } catch (err) {
      this._currentAudio = null;
      if (this.isPlaying && err.message !== 'audio error') {
        console.warn(`Sentence ${idx} skipped:`, err.message);
        this._playAt(idx + 1);
      }
    }
  },

  // ── Web Speech API playback ───────────────────────────────────────────────
  _playWebSpeechAt(idx) {
    if (idx >= this.sentences.length) {
      this.isPlaying  = false;
      this.currentIdx = 0;
      clearHighlight();
      updatePlayBtn();
      updateProgress();
      return;
    }

    this.currentIdx = idx;
    highlightSentence(idx);
    updateProgress();

    const utter = new SpeechSynthesisUtterance(this.sentences[idx].plain);
    utter.lang  = 'ja-JP';
    utter.rate  = this.rate;
    if (this.jaVoice) utter.voice = this.jaVoice;

    utter.onend  = () => { if (this.isPlaying && !this.isPaused) this._playAt(idx + 1); };
    utter.onerror = (e) => { if (e.error !== 'interrupted' && this.isPlaying) this._playAt(idx + 1); };

    speechSynthesis.speak(utter);
  }
};

// ─── Voice loading ────────────────────────────────────────────────────────────

function voiceQuality(v) {
  if (/online.*natural/i.test(v.name)) return 3;  // Natural Neural (best)
  if (/online/i.test(v.name))          return 2;  // Online cloud voice
  if (v.localService === false)        return 2;
  return 1;                                        // Standard local voice
}

// Format a SpeechSynthesisVoice name for display
function formatVoiceName(v) {
  const q = voiceQuality(v);
  // Extract first token after "Microsoft " — e.g. "Nanami", "Haruka", "Keita"
  const base = v.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Online\b.*/i, '')
    .replace(/\s+-\s+.*$/, '')
    .trim();
  if (q >= 3) return `${base} ✨ 自然音质`;
  if (q >= 2) return `${base} ☁ 在线`;
  return base;
}

function loadVoices() {
  if (tts.mode === 'server') return;  // server-side engine takes over
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;

  const jaVoices = voices
    .filter(v => v.lang === 'ja-JP' || v.lang === 'ja' || v.lang.startsWith('ja-'))
    .sort((a, b) => voiceQuality(b) - voiceQuality(a));

  if (!jaVoices.length) {
    if (!state._voiceWarned) {
      state._voiceWarned = true;
      showMessage('未检测到日语语音。请用 Microsoft Edge 浏览器打开，或前往 Windows 设置 → 时间和语言 → 语音 → 添加语音，安装"日本語"语音包后重启浏览器。', 'warn');
    }
    return;
  }

  tts.jaVoice = jaVoices[0];

  populateSpeakerSelect(jaVoices.map(v => ({ id: v.name, name: formatVoiceName(v) })));
  document.getElementById('speakerSelect')?.classList.remove('hidden');

  // Show "安装自然音质" hint if best voice is only standard quality
  const hasNatural = jaVoices.some(v => voiceQuality(v) >= 3);
  document.getElementById('naturalVoiceHint')?.classList.toggle('hidden', hasNatural);

  const best = jaVoices[0];
  if (voiceQuality(best) >= 2) {
    setTtsIndicator('edge-webspeech', best.name);
  } else {
    setTtsIndicator('webspeech', best.name);
  }
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

// ─── VOICEVOX detection ───────────────────────────────────────────────────────

async function initTtsMode() {
  try {
    const status = await fetch('/api/tts/status').then(r => r.json());
    if (!status.available) { loadVoices(); return; }

    // Quick synthesis test — verify the engine actually produces audio
    const testRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'テスト', voice: 'ja-JP-NanamiNeural', speed: 1.0 })
    });

    if (!testRes.ok) {
      console.warn('TTS synthesis test failed, falling back to Web Speech');
      loadVoices();  // sets correct badge based on available browser voices
      return;
    }

    tts.mode = 'server';
    speechSynthesis.cancel();  // stop any Web Speech that started during async test window
    setTtsIndicator(status.engine, status.version);

    const spData = await fetch('/api/tts/speakers').then(r => r.json());
    if (spData.speakers?.length) {
      populateSpeakerSelect(spData.speakers);
      tts.speakerId = spData.speakers[0]?.id ?? 'ja-JP-NanamiNeural';
    }
  } catch {
    loadVoices();  // sets correct badge based on available browser voices
  }
}

function setTtsIndicator(engine, version) {
  const el  = document.getElementById('ttsModeIndicator');
  if (!el) return;
  if (engine === 'voicevox') {
    el.textContent = `🎙 VOICEVOX${version ? ' ' + version : ''}`;
    el.className   = 'tts-badge tts-voicevox';
  } else if (engine === 'edge') {
    el.textContent = '✨ Edge Neural';
    el.className   = 'tts-badge tts-edge';
  } else if (engine === 'edge-webspeech') {
    el.textContent = '✨ Edge Neural';
    el.className   = 'tts-badge tts-edge';
  } else {
    el.textContent = '🔊 系统语音';
    el.className   = 'tts-badge tts-webspeech';
    document.getElementById('speakerSelect')?.classList.add('hidden');
  }
}

function populateSpeakerSelect(speakers) {
  const sel = document.getElementById('speakerSelect');
  if (!sel) return;
  sel.innerHTML = speakers.map(s =>
    `<option value="${s.id}"${s.id === tts.speakerId ? ' selected' : ''}>${s.name}</option>`
  ).join('');
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function showView(name) {
  state.view = name;
  document.getElementById('welcomePanel').classList.toggle('hidden', name !== 'welcome');
  document.getElementById('loadingPanel').classList.toggle('hidden', name !== 'loading');
  document.getElementById('articleDisplay').classList.toggle('hidden', name !== 'article');
}

function setLoadStep(step) {
  // step: 'fetch' | 'furigana' | 'translate' | null
  const steps = ['fetch', 'furigana', 'translate'];
  steps.forEach(s => {
    const el = document.getElementById(`step-${s}`);
    if (!el) return;
    el.classList.remove('done', 'active');
    const idx = steps.indexOf(s);
    const cur = steps.indexOf(step);
    if (idx < cur)  el.classList.add('done');
    if (idx === cur) el.classList.add('active');
    const icons = ['⬜', '✅', '✅'];
    el.textContent = el.textContent.replace(/^[⬜✅⏳]\s*/, (idx < cur ? '✅ ' : idx === cur ? '⏳ ' : '⬜ '));
  });
}

function resetLoadSteps() {
  ['fetch','furigana','translate'].forEach(s => {
    const el = document.getElementById(`step-${s}`);
    if (!el) return;
    el.classList.remove('done', 'active');
    const labels = { fetch: '获取文章', furigana: '生成假名注音', translate: '翻译文章' };
    el.textContent = `⬜ ${labels[s]}`;
  });
}

function markLoadStep(step, done = true) {
  const el = document.getElementById(`step-${step}`);
  if (!el) return;
  el.classList.remove('active');
  if (done) {
    el.classList.add('done');
    const labels = { fetch: '获取文章', furigana: '生成假名注音', translate: '翻译文章' };
    el.textContent = `✅ ${labels[step]}`;
  }
}

function activateLoadStep(step) {
  const labels = { fetch: '获取文章', furigana: '生成假名注音', translate: '翻译文章' };
  const el = document.getElementById(`step-${step}`);
  if (!el) return;
  el.classList.add('active');
  el.textContent = `⏳ ${labels[step]}`;
}

function updatePlayBtn() {
  const btn = document.getElementById('playBtn');
  if (!btn) return;
  btn.textContent     = tts.isPlaying ? '⏸' : '▶';
  btn.title           = tts.isPlaying ? '暂停' : '播放';
  btn.classList.toggle('playing', tts.isPlaying);
}

function updateProgress() {
  const el = document.getElementById('progressLabel');
  if (!el) return;
  if (!state.sentences.length) { el.textContent = '— / —'; return; }
  el.textContent = `${tts.currentIdx + 1} / ${state.sentences.length} 句`;
}

function highlightSentence(idx) {
  document.querySelectorAll('.sentence-block').forEach(el => el.classList.remove('active'));
  const target = document.querySelector(`.sentence-block[data-idx="${idx}"]`);
  if (target) {
    target.classList.add('active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  updateCurrentSentenceCtx(idx);
}

function clearHighlight() {
  document.querySelectorAll('.sentence-block.active').forEach(el => el.classList.remove('active'));
  updateCurrentSentenceCtx(null);
}

function updateCurrentSentenceCtx(idx) {
  const box      = document.getElementById('currentSentenceCtx');
  const progEl   = document.getElementById('ctxProgress');
  const textEl   = document.getElementById('ctxText');
  if (!box) return;
  if (idx === null || idx === undefined || !state.sentences[idx]) {
    box.classList.add('hidden');
    return;
  }
  const s = state.sentences[idx];
  progEl.textContent = `${idx + 1} / ${state.sentences.length}`;
  textEl.textContent = s.plain;
  box.classList.remove('hidden');
}

function showMessage(msg, type = 'error') {
  // Temporary banner below header
  let banner = document.getElementById('global-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'global-banner';
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:100;padding:10px 20px;
      font-size:13px;text-align:center;transition:opacity .4s`;
    document.body.appendChild(banner);
  }
  banner.style.background = type === 'warn' ? '#fef3c7' : type === 'info' ? '#ecfdf5' : '#fee2e2';
  banner.style.color      = type === 'warn' ? '#92400e' : type === 'info' ? '#065f46'  : '#991b1b';
  banner.style.opacity    = '1';
  banner.textContent      = msg;
  setTimeout(() => { banner.style.opacity = '0'; }, 6000);
}

// ─── Article rendering ────────────────────────────────────────────────────────

function hasValidLlmConfig() {
  if (!llmConfig) return false;
  if (llmConfig.type === 'anthropic') return !!(llmConfig.apiKey);
  return !!(llmConfig.baseUrl);  // OpenAI-compat: Ollama 等无需 key
}

function updateLlmWarning(hasTranslation) {
  const el = document.getElementById('noKeyWarning');
  if (!el) return;
  // If explicitly told translation worked, hide; if told it didn't, show.
  // When called without argument (after save), derive from current config.
  const show = hasTranslation === undefined ? !hasValidLlmConfig() : hasTranslation === false;
  el.classList.toggle('hidden', !show);
}

function renderArticle(sentences, title, hasTranslation, sourceUrl = null) {
  state.sentences    = sentences;
  state.articleTitle = title;

  document.getElementById('articleTitle').textContent = title;

  // Source URL — shown as clickable link, not spoken
  const sourceEl   = document.getElementById('articleSource');
  const sourceLinkEl = document.getElementById('articleSourceLink');
  if (sourceUrl) {
    sourceLinkEl.href        = sourceUrl;
    sourceLinkEl.textContent = sourceUrl;
    sourceLinkEl.title       = sourceUrl;
    sourceEl.classList.remove('hidden');
  } else {
    sourceEl.classList.add('hidden');
  }

  updateLlmWarning(hasTranslation);

  const content = document.getElementById('articleContent');
  content.innerHTML = sentences.map(s => `
    <div class="sentence-block" data-idx="${s.idx}">
      <span class="sentence-text">${s.furigana}</span>
      <div class="sentence-translation">${escHtml(s.translation)}</div>
    </div>`).join('');

  content.querySelectorAll('.sentence-block').forEach(el => {
    el.addEventListener('click', () => {
      stopChatTts();
      tts.jumpTo(parseInt(el.dataset.idx, 10));
    });
  });

  tts.currentIdx = 0;
  tts.isPlaying  = false;
  tts.isPaused   = false;
  updatePlayBtn();
  updateProgress();
  showView('article');

  // If translation toggle was already on, fetch translations for this new article
  const tog = document.getElementById('translationToggle');
  if (tog?.checked && sentences.every(s => !s.translation)) {
    fetchTranslationsOnDemand();
  }
}

function escHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function api(endpoint, body, method = 'POST') {
  const opts = method === 'GET'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res  = await fetch(endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function doSearch(query) {
  const searchBtn = document.getElementById('searchBtn');
  searchBtn.disabled = true;
  searchBtn.textContent = '搜索中…';
  document.getElementById('searchResults').innerHTML = '';

  try {
    const data = await api('/api/search', { action: 'search', query });

    if (data.message) {
      document.getElementById('searchResults').innerHTML =
        `<div class="search-msg">${escHtml(data.message)}</div>`;
      return;
    }

    const container = document.getElementById('searchResults');
    data.results.forEach(r => {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.innerHTML = `<div class="result-title">${escHtml(r.title)}</div>
                       <div class="result-snippet">${escHtml(r.snippet)}…</div>`;
      div.addEventListener('click', () => loadArticle(r.pageid, r.title));
      container.appendChild(div);
    });
  } catch (err) {
    document.getElementById('searchResults').innerHTML =
      `<div class="search-msg" style="color:#ef4444">搜索失败：${escHtml(err.message)}</div>`;
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '搜索';
  }
}

async function loadArticle(pageid, title) {
  document.getElementById('searchResults').innerHTML = '';
  showView('loading');
  resetLoadSteps();

  try {
    activateLoadStep('fetch');
    const article = await api('/api/search', { action: 'fetch', pageid });
    markLoadStep('fetch');

    state.articleText = article.text;
    await processText(article.text, article.title, article.url);
  } catch (err) {
    showView('welcome');
    showMessage(`加载失败：${err.message}`);
  }
}

async function loadFromUrl(url) {
  if (!url.trim()) return;
  showView('loading');
  resetLoadSteps();

  try {
    activateLoadStep('fetch');
    const article = await api('/api/fetch-url', { url });
    markLoadStep('fetch');

    state.articleText = article.text;
    await processText(article.text, article.title, article.url);
  } catch (err) {
    showView('welcome');
    showMessage(`提取失败：${err.message}`);
  }
}

async function loadCustomText(text) {
  if (!text.trim()) return;
  showView('loading');
  resetLoadSteps();
  markLoadStep('fetch');
  state.articleText = text;
  await processText(text, '自定义文本', null);
}

async function processText(text, title, sourceUrl = null) {
  try {
    activateLoadStep('furigana');
    activateLoadStep('translate');

    const data = await api('/api/process', { text, targetLang: state.targetLang, llmConfig });

    markLoadStep('furigana');
    markLoadStep('translate');

    state.chatHistory = [];
    clearChatMessages();

    renderArticle(data.sentences, title, data.hasTranslation, sourceUrl);
  } catch (err) {
    showView('welcome');
    showMessage(`处理失败：${err.message}`);
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function clearChatMessages() {
  const el = document.getElementById('chatMessages');
  el.innerHTML = `<div class="chat-msg assistant">
    <div class="msg-body">
      文章已加载！你可以向我提问：<br>
      • 任何词汇的读音和意思<br>
      • 句子的语法结构分析<br>
      • 对文章内容的疑问<br>
      • 日本文化背景知识
    </div>
  </div>`;
}

function appendChatMsg(role, html) {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="msg-body">${html}</div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

function showTyping() {
  return appendChatMsg('assistant',
    '<span class="typing-dots"><span></span><span></span><span></span></span>');
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.style.height = 'auto';

  state.chatHistory.push({ role: 'user', content: msg });
  appendChatMsg('user', escHtml(msg).replace(/\n/g, '<br>'));

  const typingEl = showTyping();
  const sendBtn  = document.getElementById('sendBtn');
  sendBtn.disabled = true;

  try {
    const curSentence = state.sentences[tts.currentIdx];
    const data = await api('/api/chat', {
      messages:        state.chatHistory,
      articleText:     state.articleText,
      targetLang:      state.targetLang,
      llmConfig,
      currentSentence: curSentence
        ? { idx: tts.currentIdx, plain: curSentence.plain, total: state.sentences.length }
        : null
    });

    typingEl.remove();
    state.chatHistory.push({ role: 'assistant', content: data.reply });

    const rendered = typeof marked !== 'undefined'
      ? marked.parse(data.reply)
      : escHtml(data.reply).replace(/\n/g, '<br>');
    appendChatMsg('assistant', rendered);

    if (autoReadChat && !tts.isPlaying) speakChatText(data.reply);
  } catch (err) {
    typingEl.remove();
    appendChatMsg('error', escHtml(err.message));
  } finally {
    sendBtn.disabled = false;
  }
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.remove('hidden');
  });
});

document.getElementById('searchBtn').addEventListener('click', () => {
  const q = document.getElementById('searchInput').value.trim();
  if (q) doSearch(q);
});

document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = document.getElementById('searchInput').value.trim();
    if (q) doSearch(q);
  }
});

document.getElementById('loadUrlBtn').addEventListener('click', () => {
  const url = document.getElementById('urlInput').value.trim();
  if (url) loadFromUrl(url);
});

document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = document.getElementById('urlInput').value.trim();
    if (url) loadFromUrl(url);
  }
});

document.getElementById('loadTextBtn').addEventListener('click', () => {
  const text = document.getElementById('pasteInput').value.trim();
  if (text) loadCustomText(text);
});

document.getElementById('playBtn').addEventListener('click', () => {
  if (!state.sentences.length) return;
  stopChatTts();   // stop chat TTS when article playback starts
  tts.toggle();
});

document.getElementById('prevBtn').addEventListener('click', () => {
  if (state.sentences.length) tts.prev();
});

document.getElementById('nextBtn').addEventListener('click', () => {
  if (state.sentences.length) tts.next();
});

document.getElementById('speedSlider').addEventListener('input', e => {
  const r = parseFloat(e.target.value);
  document.getElementById('speedLabel').textContent = r.toFixed(1) + '×';
  tts.setRate(r);
});

document.getElementById('langSelect').addEventListener('change', e => {
  state.targetLang = e.target.value;
});

document.getElementById('furiganaToggle').addEventListener('change', e => {
  document.getElementById('articleContent')
    .classList.toggle('hide-furigana', !e.target.checked);
});

document.getElementById('translationToggle').addEventListener('change', async e => {
  document.getElementById('articleContent')
    .classList.toggle('show-translation', e.target.checked);

  // If toggling on and translations are missing, fetch them now
  if (e.target.checked && state.sentences.length &&
      state.sentences.every(s => !s.translation)) {
    await fetchTranslationsOnDemand();
  }
});

async function fetchTranslationsOnDemand() {
  const toggle = document.getElementById('translationToggle');
  toggle.disabled = true;
  const span = toggle.closest('label')?.querySelector('span');
  const origText = span?.textContent ?? '显示翻译';
  if (span) span.textContent = '翻译中…';

  try {
    const data = await api('/api/translate', {
      sentences:  state.sentences.map(s => s.plain),
      targetLang: state.targetLang,
      llmConfig
    });
    if (data.translations?.length) {
      data.translations.forEach((t, i) => {
        if (!state.sentences[i]) return;
        state.sentences[i].translation = t;
        const el = document.querySelector(
          `#articleContent .sentence-block[data-idx="${i}"] .sentence-translation`
        );
        if (el) el.textContent = t;
      });
    }
  } catch (err) {
    showMessage('翻译失败：' + err.message);
    toggle.checked = false;
    document.getElementById('articleContent').classList.remove('show-translation');
  } finally {
    toggle.disabled = false;
    if (span) span.textContent = origText;
  }
}

document.getElementById('subtitleToggle').addEventListener('change', e => {
  document.getElementById('articlePanel')
    .classList.toggle('subtitle-mode', e.target.checked);
});

document.getElementById('sendBtn').addEventListener('click', sendChat);

document.getElementById('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

document.getElementById('chatInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ── Auto-read toggle ──────────────────────────────────────────────────────────
const autoReadToggle = document.getElementById('autoReadToggle');
autoReadToggle.checked = autoReadChat;
autoReadToggle.addEventListener('change', e => {
  autoReadChat = e.target.checked;
  localStorage.setItem('autoReadChat', autoReadChat);
  if (!autoReadChat) stopChatTts();
});

// ── Voice input (SpeechRecognition) ──────────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn     = document.getElementById('micBtn');
const micLangBtn = document.getElementById('micLangBtn');

if (!SpeechRec) {
  micBtn.style.display     = 'none';
  micLangBtn.style.display = 'none';
} else {
  let recognition = null;
  let isRecording = false;

  function updateMicLangBtn() {
    micLangBtn.textContent = micLang === 'zh-CN' ? '中' : '日';
    micLangBtn.title = micLang === 'zh-CN' ? '当前：中文识别（点击切日语）' : '当前：日語識別（点击切中文）';
  }
  updateMicLangBtn();

  micLangBtn.addEventListener('click', () => {
    micLang = micLang === 'zh-CN' ? 'ja-JP' : 'zh-CN';
    localStorage.setItem('micLang', micLang);
    updateMicLangBtn();
    if (isRecording) stopRecording();
  });

  function startRecording() {
    recognition = new SpeechRec();
    recognition.lang = micLang;
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isRecording = true;
      micBtn.classList.add('active');
      micBtn.title = '点击停止';
    };

    const chatInput = document.getElementById('chatInput');
    const base = chatInput.value;

    recognition.onresult = e => {
      const transcript = Array.from(e.results)
        .map(r => r[0].transcript).join('');
      chatInput.value = base + transcript;
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    };

    recognition.onend = () => { stopRecording(false); };
    recognition.onerror = () => { stopRecording(false); };

    recognition.start();
  }

  function stopRecording(cancel = true) {
    isRecording = false;
    micBtn.classList.remove('active');
    micBtn.title = '语音输入';
    if (cancel && recognition) recognition.abort();
    recognition = null;
  }

  micBtn.addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
  });
}

document.getElementById('speakerSelect')?.addEventListener('change', e => {
  const val = e.target.value;
  if (tts.mode === 'server') {
    // VOICEVOX: numeric ID; Edge server: string voice name
    tts.speakerId = /^\d+$/.test(val) ? parseInt(val, 10) : val;
  } else {
    // Web Speech: find voice by name
    tts.jaVoice = speechSynthesis.getVoices().find(v => v.name === val) || tts.jaVoice;
  }
  if (tts.isPlaying) { tts._cancelCurrent(); tts._playAt(tts.currentIdx); }
});

// ─── LLM Settings Modal ───────────────────────────────────────────────────────

function openLlmModal() {
  const modal = document.getElementById('llmModal');
  // Populate fields from current config
  document.querySelectorAll('input[name="llmType"]').forEach(r => {
    r.checked = r.value === llmConfig.type;
  });
  document.getElementById('llmBaseUrl').value = llmConfig.baseUrl || '';
  document.getElementById('llmApiKey').value  = llmConfig.apiKey  || '';
  document.getElementById('llmModel').value   = llmConfig.model   || '';
  toggleBaseUrlRow();
  renderHistoryList();
  modal.classList.remove('hidden');
}

function closeLlmModal() {
  document.getElementById('llmModal').classList.add('hidden');
  document.getElementById('llmTestResult').textContent = '';
  document.getElementById('llmTestResult').className = 'test-result';
  document.getElementById('modelSelect').classList.add('hidden');
}

function toggleBaseUrlRow() {
  const isOpenAI = document.querySelector('input[name="llmType"]:checked')?.value === 'openai';
  document.getElementById('baseUrlRow').style.opacity = isOpenAI ? '1' : '0.4';
  document.getElementById('llmBaseUrl').disabled = !isOpenAI;
}

document.getElementById('llmSettingsBtn').addEventListener('click', openLlmModal);
document.getElementById('llmModalClose').addEventListener('click', closeLlmModal);
document.getElementById('llmModal').addEventListener('click', e => {
  if (e.target === document.getElementById('llmModal')) closeLlmModal();
});

document.querySelectorAll('input[name="llmType"]').forEach(r => {
  r.addEventListener('change', toggleBaseUrlRow);
});

// Fetch model list — shared helper used by button and preset auto-fetch
async function fetchAndShowModels(baseUrl) {
  const fetchBtn = document.getElementById('fetchModelsBtn');
  const sel      = document.getElementById('modelSelect');
  fetchBtn.disabled = true; fetchBtn.textContent = '获取中…';
  sel.classList.add('hidden');
  try {
    const data = await api(`/api/llm/models?baseUrl=${encodeURIComponent(baseUrl)}`, null, 'GET');
    if (data.models?.length) {
      sel.innerHTML = data.models.map(m => `<option value="${m}">${m}</option>`).join('');
      sel.classList.remove('hidden');
      // Set model input to first item immediately
      document.getElementById('llmModel').value = data.models[0];
    } else {
      showMessage(data.error || '未找到已下载模型，请先用 ollama pull 下载', 'warn');
    }
  } catch (e) {
    showMessage('获取失败：' + e.message);
  } finally {
    fetchBtn.disabled = false; fetchBtn.textContent = '获取列表';
  }
}

// Model select → sync to text input (no { once } so every change works)
document.getElementById('modelSelect').addEventListener('change', e => {
  document.getElementById('llmModel').value = e.target.value;
});

// Preset buttons
document.querySelectorAll('.btn-preset').forEach(btn => {
  btn.addEventListener('click', async () => {
    const preset = LLM_PRESETS[btn.dataset.preset];
    if (!preset) return;
    document.querySelectorAll('input[name="llmType"]').forEach(r => {
      r.checked = r.value === preset.type;
    });
    document.getElementById('llmBaseUrl').value = preset.baseUrl;
    document.getElementById('llmModel').value   = preset.model;
    toggleBaseUrlRow();
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('modelSelect').classList.add('hidden');

    // Ollama: auto-fetch installed models right away
    if (btn.dataset.preset === 'ollama') {
      await fetchAndShowModels(preset.baseUrl);
    }
  });
});

// Manual fetch button
document.getElementById('fetchModelsBtn').addEventListener('click', () => {
  const baseUrl = document.getElementById('llmBaseUrl').value.trim() || 'http://localhost:11434/v1';
  fetchAndShowModels(baseUrl);
});

// Test connection
document.getElementById('llmTestBtn').addEventListener('click', async () => {
  const testConfig = {
    type:    document.querySelector('input[name="llmType"]:checked')?.value || 'openai',
    baseUrl: document.getElementById('llmBaseUrl').value.trim(),
    apiKey:  document.getElementById('llmApiKey').value.trim(),
    model:   document.getElementById('llmModel').value.trim(),
  };
  const resultEl = document.getElementById('llmTestResult');
  const btn = document.getElementById('llmTestBtn');
  resultEl.textContent = '测试中…'; resultEl.className = 'test-result';
  btn.disabled = true;
  try {
    const data = await api('/api/llm/test', { llmConfig: testConfig });
    if (data.ok) {
      resultEl.textContent = '✓ 连接成功';
      resultEl.className = 'test-result ok';
    } else {
      resultEl.textContent = '✗ ' + (data.error || '未知错误');
      resultEl.className = 'test-result fail';
    }
  } catch (e) {
    resultEl.textContent = '✗ ' + e.message;
    resultEl.className = 'test-result fail';
  } finally {
    btn.disabled = false;
  }
});

// History list interaction
document.getElementById('llmHistoryList').addEventListener('click', e => {
  const delId = e.target.dataset.del;
  if (delId) {
    llmHistory = llmHistory.filter(h => h.id !== delId);
    localStorage.setItem('llmHistory', JSON.stringify(llmHistory));
    renderHistoryList();
    return;
  }
  const item = e.target.closest('.history-item');
  if (!item) return;
  const h = llmHistory.find(h => h.id === item.dataset.id);
  if (!h) return;
  document.querySelectorAll('input[name="llmType"]').forEach(r => r.checked = r.value === h.type);
  document.getElementById('llmBaseUrl').value = h.baseUrl || '';
  document.getElementById('llmApiKey').value  = h.apiKey  || '';
  document.getElementById('llmModel').value   = h.model   || '';
  toggleBaseUrlRow();
  renderHistoryList();
});

// Save
document.getElementById('llmSaveBtn').addEventListener('click', () => {
  llmConfig = {
    type:    document.querySelector('input[name="llmType"]:checked')?.value || 'openai',
    baseUrl: document.getElementById('llmBaseUrl').value.trim(),
    apiKey:  document.getElementById('llmApiKey').value.trim(),
    model:   document.getElementById('llmModel').value.trim(),
  };
  saveLlmConfig();
  saveToHistory(llmConfig);
  closeLlmModal();
  showMessage('✓ 模型配置已保存', 'info');
  updateLlmWarning();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

showView('welcome');
updatePlayBtn();
updateProgress();
initTtsMode();
