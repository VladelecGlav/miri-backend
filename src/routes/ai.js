import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const AIMLAPI_KEY = process.env.AIMLAPI_KEY;
const BASE = 'https://api.aimlapi.com/v2';

// ── POST /api/ai/generate-video ─────────────────────────
router.post('/generate-video', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const {
    prompt,
    model = 'kling-video/v1.6/standard/text-to-video',  // v1.6 — актуальная версия
    duration = '5',
    ratio = '9:16',
    image_url
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });

  try {
    const body = { model, prompt, duration, ratio };
    if (image_url) body.image_url = image_url;

    // Новый универсальный endpoint aimlapi
    const resp = await fetch(`${BASE}/video/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIMLAPI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const errMsg = typeof data.error === 'string' ? data.error
        : (data.error?.message || data.message || 'Ошибка API ' + resp.status);
      return res.status(resp.status).json({ error: errMsg });
    }

    res.json({ generation_id: data.id || data.generation_id, status: data.status || 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/ai/video-status/:id ────────────────────────
router.get('/video-status/:id', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  try {
    const resp = await fetch(`${BASE}/video/generations?generation_id=${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${AIMLAPI_KEY}` },
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || data.error || 'Ошибка API' });

    res.json({
      status: data.status,
      video_url: data.video?.url || null,
      error: data.error?.message || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ai/generate-video-veo ─────────────────────
// Google Veo через aimlapi (если доступен)
router.post('/generate-video-veo', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const { prompt, model = 'google/veo-3.1-fast-generate-preview', duration = '8', ratio = '9:16' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });

  try {
    const resp = await fetch(`${BASE}/video/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIMLAPI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt, duration, ratio }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const errMsg = typeof data.error === 'string' ? data.error
        : (data.error?.message || data.message || 'Ошибка API ' + resp.status);
      return res.status(resp.status).json({ error: errMsg });
    }

    res.json({ generation_id: data.id || data.generation_id, status: data.status || 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ai/translate ───────────────────────────────
// DeepSeek — перевод промптов (в 21× дешевле Claude)
router.post('/translate', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const { system, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });

  try {
    const resp = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIMLAPI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        max_tokens: 300,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt }
        ],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return res.json({ text: prompt }); // fallback

    const text = data.choices?.[0]?.message?.content || prompt;
    res.json({ text });
  } catch (e) {
    res.json({ text: prompt }); // fallback — не ломаем генерацию
  }
});

// ── POST /api/ai/chat (streaming) ───────────────────────
router.post('/chat', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const { model = 'claude-sonnet-4-20250514', system, prompt, provider = 'claude' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  try {
    if (provider === 'claude') {
      // Claude streaming через Anthropic API
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          stream: true,
          system: system || 'Ты полезный ассистент.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        send({ error: err.error?.message || 'Ошибка Claude' });
        return res.end();
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              send({ token: evt.delta.text });
            }
          } catch {}
        }
      }
      send({ done: true });
      return res.end();
    }

    // Все остальные — через aimlapi streaming
    const resp = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIMLAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        stream: true,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      const errMsg = typeof err.error === 'string' ? err.error : (err.error?.message || 'Ошибка API');
      send({ error: errMsg });
      return res.end();
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { send({ done: true }); continue; }
        try {
          const evt = JSON.parse(raw);
          const token = evt.choices?.[0]?.delta?.content;
          if (token) send({ token });
        } catch {}
      }
    }
    send({ done: true });
    res.end();
  } catch (e) {
    send({ error: e.message });
    res.end();
  }
});

export default router;