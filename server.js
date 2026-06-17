require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;


// kuroshiro setup
const _Kuroshiro = require('kuroshiro');
const Kuroshiro = _Kuroshiro.default || _Kuroshiro;
const _Kuromoji = require('kuroshiro-analyzer-kuromoji');
const KuromojiAnalyzer = _Kuromoji.default || _Kuromoji;
const kuroshiro = new Kuroshiro();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasJapanese(text) {
  return /[぀-ゟ゠-ヿ一-龯･-ﾟ]/.test(text);
}

function splitSentences(text) {
  return text
    .replace(/\[\d+\]/g, '')              // strip Wikipedia refs like [1]
    .replace(/\r\n/g, '\n')
    .replace(/[。！？]/g, m => m + '\n')   // break after each sentence end
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length >= 5 && hasJapanese(s) && /[。！？]/.test(s));
}

async function searchWikipedia(query) {
  const url = 'https://ja.wikipedia.org/w/api.php?' +
    `action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    '&utf8=&format=json&srlimit=5&srnamespace=0&origin=*';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'japanese-practice-app/1.0 (local learning tool)' }
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const data = await res.json();
  return (data.query?.search || []).map(r => ({
    title: r.title,
    pageid: r.pageid,
    snippet: r.snippet.replace(/<[^>]+>/g, '').substring(0, 120)
  }));
}

async function fetchWikipediaArticle(pageid) {
  const url = 'https://ja.wikipedia.org/w/api.php?' +
    `action=query&prop=extracts&explaintext&redirects=1&pageids=${pageid}&format=json&origin=*`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'japanese-practice-app/1.0 (local learning tool)' }
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const data = await res.json();
  const pages = data.query?.pages || {};
  const page = pages[Object.keys(pages)[0]];
  if (!page || page.missing !== undefined) throw new Error('Article not found');
  return {
    title: page.title,
    text: (page.extract || '').substring(0, 3000),
    url: `https://ja.wikipedia.org/?curid=${pageid}`
  };
}

async function extractFromUrl(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,zh-CN;q=0.9,zh;q=0.8,en;q=0.7',
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`页面无法访问（HTTP ${res.status}）`);

  const html = await res.text();

  // Strip noise: scripts, styles, nav, etc.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Title: prefer <h1>, fallback to <title>
  const h1 = stripped.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const ttl = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = (h1 ? h1[1] : ttl ? ttl[1] : targetUrl)
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // Find main content area: <article> > <main> > body
  let content = stripped;
  const articleM = stripped.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainM    = stripped.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleM) content = articleM[1];
  else if (mainM) content = mainM[1];

  // Extract <p> text with Japanese
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let m;
  while ((m = paraRegex.exec(content)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
      .replace(/&[a-z]+;/g, '').replace(/\s+/g, ' ').trim();
    if (text.length >= 15 && hasJapanese(text)) paragraphs.push(text);
  }

  if (!paragraphs.length) {
    throw new Error('未能从该页面提取到日语文章内容。建议直接复制文章文字，粘贴到「粘贴文本」标签中。');
  }

  return { title, text: paragraphs.join('\n').substring(0, 3000), url: targetUrl };
}

// ─── Unified LLM caller ───────────────────────────────────────────────────────
// config: { type:'anthropic'|'openai', apiKey, baseUrl, model }
// messages: OpenAI-format array [{role,content}]
// system: string

async function callLLM(config, messages, system, maxTokens = 2048) {
  const type    = config?.type || 'anthropic';
  const apiKey  = config?.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = (config?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model   = config?.model || (type === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini');

  if (type === 'anthropic') {
    if (!apiKey) throw new Error('需要 Anthropic API Key（在 ⚙ 设置中配置）');
    const Mod = require('@anthropic-ai/sdk');
    const Anthropic = Mod.default || Mod;
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages });
    return res.content[0].text;
  }

  // OpenAI-compatible (OpenAI / Ollama / DeepSeek / Groq / LM Studio / …)
  const allMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: allMessages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function hasLLM(config) {
  const type = config?.type || 'anthropic';
  if (type === 'anthropic') return !!(config?.apiKey || process.env.ANTHROPIC_API_KEY);
  return !!(config?.baseUrl);   // OpenAI-compat: base URL is enough (Ollama needs no key)
}

function parseTranslationLines(raw, count) {
  // Parse "1. text" or "1) text" numbered lines — robust against JSON issues
  const result = new Array(count).fill('');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < count) result[idx] = m[2].trim();
    }
  }
  return result;
}

async function translateBatch(sentences, targetLang, llmConfig) {
  if (!hasLLM(llmConfig) || sentences.length === 0) return sentences.map(() => '');

  const CHUNK = 10;
  const langLabel = targetLang === 'zh'
    ? 'Simplified Chinese (简体中文，必须使用简体字，严禁繁体字，以中国大陆标准输出)'
    : 'English';
  const system = `Translate each numbered Japanese sentence into ${langLabel}.\nOutput the translations as a numbered list in exactly the same format:\n1. [translation]\n2. [translation]\nOne line per sentence, same numbering. No other text.`;

  const results = [];
  for (let i = 0; i < sentences.length; i += CHUNK) {
    const chunk = sentences.slice(i, i + CHUNK);
    const numbered = chunk.map((s, j) => `${j + 1}. ${s}`).join('\n');
    try {
      const raw = await callLLM(llmConfig, [{ role: 'user', content: numbered }], system, 1024);
      const parsed = parseTranslationLines(raw, chunk.length);
      for (let j = 0; j < chunk.length; j++) {
        results.push(parsed[j] || '');
      }
    } catch (err) {
      console.error(`Translation chunk [${i}–${i + chunk.length - 1}]:`, err.message);
      chunk.forEach(() => results.push(''));
    }
  }
  return results;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// POST /api/fetch-url — extract Japanese text from any URL
app.post('/api/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url?.trim()) return res.status(400).json({ error: '请提供网页 URL' });

    // Basic URL validation
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: '无效的 URL 格式' }); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: '仅支持 http 和 https 链接' });
    }

    const result = await extractFromUrl(url);
    res.json(result);
  } catch (err) {
    console.error('/api/fetch-url:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// body: { action: 'search', query } | { action: 'fetch', pageid }
app.post('/api/search', async (req, res) => {
  try {
    const { action, query, pageid } = req.body;

    if (action === 'search') {
      if (!query?.trim()) return res.status(400).json({ error: '请输入搜索词' });
      const results = await searchWikipedia(query.trim());
      if (results.length === 0) {
        return res.json({
          results: [],
          message: '未找到相关文章。提示：外来词可用片假名搜索，如"アメリカ"'
        });
      }
      return res.json({ results });
    }

    if (action === 'fetch') {
      const article = await fetchWikipediaArticle(pageid);
      return res.json(article);
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('/api/search:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// body: { text, targetLang, llmConfig? }
app.post('/api/process', async (req, res) => {
  try {
    const { text, targetLang = 'zh', llmConfig } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: '请提供日文文本' });
    if (!hasJapanese(text)) return res.status(400).json({ error: '未检测到日语内容' });

    const plains = splitSentences(text);
    if (plains.length === 0) {
      return res.status(400).json({ error: '无法解析出有效句子，请确认文本包含完整日语句子（以。！？结尾）' });
    }

    const [furiganaArr, translations] = await Promise.all([
      Promise.all(plains.map(s =>
        kuroshiro.convert(s, { to: 'hiragana', mode: 'furigana' }).catch(() => s)
      )),
      translateBatch(plains, targetLang, llmConfig)
    ]);

    const sentences = plains.map((plain, idx) => ({
      idx,
      plain,
      furigana: furiganaArr[idx] || plain,
      translation: translations[idx] || ''
    }));

    res.json({ sentences, hasTranslation: hasLLM(llmConfig) });
  } catch (err) {
    console.error('/api/process:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// body: { sentences: string[], targetLang, llmConfig }
app.post('/api/translate', async (req, res) => {
  const { sentences = [], targetLang = 'zh', llmConfig } = req.body;
  if (!sentences.length) return res.status(400).json({ error: '无句子' });
  if (!hasLLM(llmConfig)) return res.status(503).json({ error: '未配置 AI 模型，请在 ⚙ 设置中配置' });
  try {
    const translations = await translateBatch(sentences, targetLang, llmConfig);
    res.json({ translations });
  } catch (err) {
    console.error('/api/translate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// body: { messages, articleText, targetLang, llmConfig?, currentSentence? }
app.post('/api/chat', async (req, res) => {
  const { messages = [], articleText = '', targetLang = 'zh', llmConfig,
          currentSentence } = req.body;
  if (!hasLLM(llmConfig)) {
    return res.status(503).json({
      error: '问答功能需要配置 AI 模型。\n请点击右上角 ⚙ 按钮，配置 API Key 或本地 Ollama。'
    });
  }
  try {
    const replyLang = targetLang === 'zh' ? '中文' : 'English';

    // Build current-sentence context block
    const ctxBlock = currentSentence?.plain
      ? `\n\n【当前进度】学生刚刚暂停在第 ${currentSentence.idx + 1} 句（共 ${currentSentence.total} 句）：\n「${currentSentence.plain}」\n当学生说"这句"、"刚才"、"这里"等时，默认指这句话。`
      : '';

    const system = `你是一名专业日语教师，正在帮助一名${replyLang === '中文' ? '中文' : '英文'}母语者学习日语。

学生正在阅读以下日文文章：
---
${articleText || '（尚未加载文章）'}
---${ctxBlock}

请用${replyLang}回答（除非学生要求用日语）。你可以帮助解答：
1. **语法**：解释文章中的语法结构、助词用法、句型、动词变形等
2. **词汇**：解释词语和汉字的读音（用平假名）和意思，以及在其他场合的用法
3. **内容**：回答关于文章内容的问题
4. **发音**：用平假名注明发音
5. **文化**：解释相关日本文化背景

引用日语时请在括号内注明平假名读音，如：東京（とうきょう）。
回答要简洁有条理，针对初学者使用清晰的语言。`;

    const reply = await callLLM(llmConfig, messages.slice(-20), system);
    res.json({ reply });
  } catch (err) {
    console.error('/api/chat:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TTS: VOICEVOX + Microsoft Edge Neural (自动检测，无需安装) ────────────────

const { WebSocket: WsClient } = require('ws');
const crypto = require('crypto');

const VOICEVOX     = 'http://localhost:50021';
const EDGE_TTS_WS  = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VOICES  = [
  { id: 'ja-JP-NanamiNeural', name: '七海（女声·自然）' },
  { id: 'ja-JP-KeitaNeural',  name: '圭太（男声·自然）' },
  { id: 'ja-JP-AoiNeural',    name: '葵（女声·活泼）'   },
  { id: 'ja-JP-DaichiNeural', name: '大地（男声·沉稳）' },
  { id: 'ja-JP-MayuNeural',   name: '茉优（女声·温柔）' },
  { id: 'ja-JP-ShioriNeural', name: '诗织（女声·清晰）' }
];

// Engine detection — cached 30s to avoid pinging VOICEVOX on every request
let _engineCache = null;
let _engineAt    = 0;

async function detectEngine() {
  if (Date.now() - _engineAt < 30000 && _engineCache) return _engineCache;
  _engineAt = Date.now();
  try {
    const r = await fetch(`${VOICEVOX}/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      const v = (await r.text()).replace(/"/g, '');
      return (_engineCache = { type: 'voicevox', version: v });
    }
  } catch {}
  return (_engineCache = { type: 'edge', version: 'Neural' });
}

// ── Edge TTS synthesis ────────────────────────────────────────────────────────
function xmlEsc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function edgeTimestamp() {
  return new Date().toISOString().replace(/[:-]/g,'').slice(0,15) + 'Z';
}

async function synthesizeEdge(text, voice, speedRatio) {
  return new Promise((resolve, reject) => {
    const connId = crypto.randomUUID().replace(/-/g,'');
    const reqId  = crypto.randomUUID().replace(/-/g,'');

    const ws = new WsClient(`${EDGE_TTS_WS}&ConnectionId=${connId}`, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
      }
    });

    const chunks = [];
    let settled  = false;

    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      clearTimeout(timer);
      err ? reject(err) : resolve(buf);
    };

    const timer = setTimeout(() => finish(new Error('Edge TTS timeout')), 15000);

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${edgeTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled:'false', wordBoundaryEnabled:'false' },
          outputFormat: 'audio-24khz-96kbitrate-mono-mp3'
        }}}})
      );
      const rate = Math.round((speedRatio - 1) * 100);
      const rateStr = (rate >= 0 ? '+' : '') + rate + '%';
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ja-JP'>` +
        `<voice name='${voice}'><prosody rate='${rateStr}'>${xmlEsc(text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${edgeTimestamp()}\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const sep = buf.indexOf(Buffer.from([0x0d,0x0a,0x0d,0x0a]));
        if (sep !== -1) chunks.push(buf.slice(sep + 4));
      } else if (data.toString().includes('Path:turn.end')) {
        finish(null, Buffer.concat(chunks));
      }
    });

    ws.on('error', (e) => finish(e));
    ws.on('close', () => {
      if (!settled) finish(chunks.length ? null : new Error('Connection closed'), Buffer.concat(chunks));
    });
  });
}

// ── VOICEVOX synthesis ────────────────────────────────────────────────────────
async function synthesizeVoicevox(text, speakerId, speedRatio) {
  const qRes = await fetch(
    `${VOICEVOX}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`,
    { method: 'POST', signal: AbortSignal.timeout(10000) }
  );
  if (!qRes.ok) throw new Error(`audio_query HTTP ${qRes.status}`);
  const query = await qRes.json();
  query.speedScale = Math.max(0.5, Math.min(2.0, speedRatio));

  const sRes = await fetch(`${VOICEVOX}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30000)
  });
  if (!sRes.ok) throw new Error(`synthesis HTTP ${sRes.status}`);
  return Buffer.from(await sRes.arrayBuffer());
}

// ── LLM utility endpoints ─────────────────────────────────────────────────────

// POST /api/llm/test — verify that a config can produce a response
app.post('/api/llm/test', async (req, res) => {
  const { llmConfig } = req.body;
  if (!llmConfig) return res.status(400).json({ ok: false, error: '缺少配置' });
  try {
    const reply = await callLLM(llmConfig, [{ role: 'user', content: 'Say "ok" in one word.' }], '');
    res.json({ ok: true, reply: reply.trim().substring(0, 50) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/llm/models?baseUrl=http://localhost:11434/v1 — list models (Ollama / OpenAI-compat)
app.get('/api/llm/models', async (req, res) => {
  const raw = (req.query.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  // Strip /v1 suffix to get the host root for Ollama native API
  const host   = raw.replace(/\/v1$/, '');
  // Ensure /v1 suffix for OpenAI-compat API
  const oaiBase = raw.endsWith('/v1') ? raw : `${raw}/v1`;
  try {
    // Try Ollama native API first (host/api/tags)
    const ollamaRes = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (ollamaRes.ok) {
      const data = await ollamaRes.json();
      return res.json({ models: (data.models || []).map(m => m.name) });
    }
    // Fall back to OpenAI-compat /v1/models
    const oaiRes = await fetch(`${oaiBase}/models`, { signal: AbortSignal.timeout(5000) });
    if (oaiRes.ok) {
      const data = await oaiRes.json();
      return res.json({ models: (data.data || []).map(m => m.id) });
    }
    res.json({ models: [], error: '无法获取模型列表，请确认 Ollama 已启动' });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// ── API endpoints ─────────────────────────────────────────────────────────────

app.get('/api/tts/status', async (req, res) => {
  const engine = await detectEngine();
  res.json({ available: true, engine: engine.type, version: engine.version });
});

app.get('/api/tts/speakers', async (req, res) => {
  const engine = await detectEngine();
  if (engine.type === 'voicevox') {
    try {
      const r = await fetch(`${VOICEVOX}/speakers`, { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      const speakers = data.flatMap(s =>
        s.styles.map(style => ({ id: style.id, name: `${s.name}（${style.name}）` }))
      );
      return res.json({ speakers, engine: 'voicevox' });
    } catch {}
  }
  res.json({ speakers: EDGE_VOICES, engine: 'edge' });
});

app.post('/api/tts', async (req, res) => {
  const { text, speakerId = 3, voice = 'ja-JP-NanamiNeural', speed = 1.0 } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text' });
  const spd = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));

  try {
    const engine = await detectEngine();
    let audio, mime;

    if (engine.type === 'voicevox') {
      audio = await synthesizeVoicevox(text, Number(speakerId) || 3, spd);
      mime  = 'audio/wav';
    } else {
      audio = await synthesizeEdge(text, voice || 'ja-JP-NanamiNeural', spd);
      mime  = 'audio/mpeg';
    }

    res.set({ 'Content-Type': mime, 'Content-Length': audio.length });
    res.send(audio);
  } catch (err) {
    _engineCache = null;  // reset cache so next request re-detects
    console.error('/api/tts:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('⏳ 正在加载日语词典（约 2-5 秒）...');
  try {
    await kuroshiro.init(new KuromojiAnalyzer());
    console.log('✓ 词典加载完成');
  } catch (err) {
    console.error('✗ 词典加载失败:', err.message);
    process.exit(1);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    console.log('✓ Anthropic API 已配置（默认）');
  } else {
    console.log('ℹ  未设置环境变量 API Key — 请在页面 ⚙ 设置中配置大模型');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 日語練習已启动：http://localhost:${PORT}\n`);
  });
})();
