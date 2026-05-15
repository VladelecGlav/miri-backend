import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { dbGet, dbRun } from '../models/migrate.js';

const router = Router();
const AIMLAPI_KEY = process.env.AIMLAPI_KEY;
const NEXUS_KEY   = process.env.NEXUS_API_KEY;
const BASE = 'https://api.aimlapi.com/v2';

// Стоимость генераций в токенах
const GEN_COSTS = { image: 3, video: 6 };

async function deductTokens(userId, type, description) {
  const cost = GEN_COSTS[type] || 0;
  if (!cost || !userId) return { ok: true, cost: 0 };

  const balance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [userId]);
  const current = balance?.balance || 0;

  if (current < cost) {
    return { ok: false, error: 'Недостаточно токенов', balance: current, cost };
  }

  await dbRun('UPDATE token_balance SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2', [cost, userId]);
  await dbRun(
    'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
    [uuid(), userId, -cost, 'spend', description || type]
  );

  return { ok: true, cost, balance: current - cost };
}

// ── POST /api/ai/generate-video ─────────────────────────
router.post('/generate-video', authenticate, async (req, res) => {
  if (!AIMLAPI_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const {
    prompt,
    model = 'kling-video/v1.6/standard/text-to-video',
    duration = '5',
    ratio = '9:16',
    image_url
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });

  // Списываем токены
  const deduct = await deductTokens(req.user.id, 'video', 'Генерация видео: ' + model);
  if (!deduct.ok) return res.status(402).json({ error: deduct.error, balance: deduct.balance, cost: deduct.cost });

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

  const { model = 'claude-sonnet-4-20250514', system, prompt, provider = 'claude', images = [] } = req.body;
  if (!prompt && !images.length) return res.status(400).json({ error: 'Промпт обязателен' });

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
    // Build message content with optional images
    let userContent;
    if (images && images.length > 0) {
      userContent = [
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.type};base64,${img.base64}` },
        })),
        { type: 'text', text: prompt || 'Опиши это изображение' },
      ];
    } else {
      userContent = prompt;
    }

    const resp = await fetch('https://api.aimlapi.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIMLAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        stream: true,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: userContent },
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

// ── POST /api/ai/generate-image — запуск генерации ──────
router.post('/generate-image', authenticate, async (req, res) => {
  const { prompt, model = 'nano-banana-2', aspect_ratio = 'auto', image_size = '1K', image_urls } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Промпт обязателен' });
  if (!NEXUS_KEY) return res.status(500).json({ error: 'Nexus API не настроен' });

  // Списываем токены
  const deduct = await deductTokens(req.user.id, 'image', 'Генерация: ' + model);
  if (!deduct.ok) return res.status(402).json({ error: deduct.error, balance: deduct.balance, cost: deduct.cost });

  try {
    console.log('generate-image req:', { model, prompt: prompt?.slice(0,30), image_urls_count: image_urls?.length || 0 });
    const resp = await fetch('https://nexusapi.dev/generate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NEXUS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        params: {
          model_name: model, prompt, image_size, aspect_ratio,
          ...(image_urls?.length ? { image_urls } : {}),
        }
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.task_id) {
      await dbRun('UPDATE token_balance SET balance=balance+$1 WHERE user_id=$2', [deduct.cost, req.user.id]);
      return res.status(400).json({ error: data.detail || data.error || 'Ошибка запуска' });
    }

    res.json({ task_id: data.task_id, balance: deduct.balance });
  } catch(e) {
    await dbRun('UPDATE token_balance SET balance=balance+$1 WHERE user_id=$2', [deduct.cost, req.user.id]);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/ai/image-status/:taskId — статус задачи ────
router.get('/image-status/:taskId', authenticate, async (req, res) => {
  if (!NEXUS_KEY) return res.status(500).json({ error: 'Nexus API не настроен' });
  try {
    const resp = await fetch(`https://nexusapi.dev/tasks/${req.params.taskId}`, {
      headers: { 'Authorization': `Bearer ${NEXUS_KEY}` },
    });
    const data = await resp.json();
    console.log('Nexus task status:', JSON.stringify(data).slice(0, 500));

    // Ищем URL в разных местах ответа
    let url = null;
    if (data.result) {
      if (typeof data.result === 'string') url = data.result;
      else if (data.result.image_urls?.length) url = data.result.image_urls[0];
      else if (data.result.url) url = data.result.url;
      else if (data.result.image_url) url = data.result.image_url;
      else if (data.result.images?.length) url = data.result.images[0];
      else if (Array.isArray(data.result)) url = data.result[0]?.url || data.result[0];
    }

    res.json({ status: data.status, url, raw: data.result, error: data.error });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ai/refund-tokens — возврат токенов ─────────
router.post('/refund-tokens', authenticate, async (req, res) => {
  const { cost, description } = req.body;
  if (!cost || cost <= 0) return res.status(400).json({ error: 'Неверная сумма' });
  try {
    await dbRun('UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [cost, req.user.id]);
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, cost, 'refund', description || 'Возврат токенов']
    );
    const balance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]);
    res.json({ success: true, balance: balance?.balance || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;