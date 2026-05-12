import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { db } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// ── Yandex Object Storage (S3-совместимый) ──────────────
const YC_BUCKET     = process.env.YC_BUCKET     || 'miri-videos';
const YC_ACCESS_KEY = process.env.YC_ACCESS_KEY || '';
const YC_SECRET_KEY = process.env.YC_SECRET_KEY || '';
const YC_ENDPOINT   = 'https://storage.yandexcloud.net';
const YC_REGION     = 'ru-central1';

// AWS4 подпись для Yandex S3
async function uploadToYandex(buffer, filename, mimetype) {
  const key  = `videos/${filename}`;
  const host = `${YC_BUCKET}.storage.yandexcloud.net`;
  const now  = new Date();
  const date = now.toISOString().slice(0,10).replace(/-/g,'');
  const time = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';

  const crypto = await import('crypto');

  const sign = (key, msg) => crypto.default.createHmac('sha256', key).update(msg).digest();
  const hex  = buf => Buffer.from(buf).toString('hex');
  const sha256hex = data => crypto.default.createHash('sha256').update(data).digest('hex');

  const payloadHash = sha256hex(buffer);
  const headers = {
    'host': host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': time,
    'content-type': mimetype,
  };
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = Object.entries(headers).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>`${k}:${v}`).join('\n') + '\n';

  const canonicalRequest = [
    'PUT', `/${key}`, '',
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const credScope = `${date}/${YC_REGION}/s3/aws4_request`;
  const strToSign = ['AWS4-HMAC-SHA256', time, credScope, sha256hex(canonicalRequest)].join('\n');

  const signingKey = sign(sign(sign(sign(`AWS4${YC_SECRET_KEY}`, date), YC_REGION), 's3'), 'aws4_request');
  const signature  = hex(sign(signingKey, strToSign));

  const authHeader = `AWS4-HMAC-SHA256 Credential=${YC_ACCESS_KEY}/${credScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  const url = `${YC_ENDPOINT}/${YC_BUCKET}/${key}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Authorization': authHeader, 'Content-Length': buffer.length },
    body: buffer,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Yandex S3 error ${resp.status}: ${text}`);
  }

  return `${YC_ENDPOINT}/${YC_BUCKET}/${key}`;
}

// Multer — держим файл в памяти для загрузки в S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500*1024*1024 }
});

function fmt(v, viewerId) {
  const author = db.prepare('SELECT id,name,handle,avatar_url FROM users WHERE id=?').get(v.user_id) || {};
  const liked  = viewerId ? !!db.prepare('SELECT 1 FROM likes WHERE user_id=? AND video_id=?').get(viewerId, v.id) : false;
  return {
    id: v.id, title: v.title, description: v.description,
    file_url: v.file_path, thumbnail_url: v.thumbnail_url,
    duration: v.duration, tags: (() => { try { return JSON.parse(v.tags); } catch { return []; } })(),
    views: v.views, likes: v.likes_count, comments: v.comments_count,
    has_ai_badge: !!v.has_ai_badge, is_public: !!v.is_public, status: v.status,
    author: { id: author.id, name: author.name, handle: author.handle, avatar_url: author.avatar_url },
    liked, created_at: v.created_at,
  };
}

router.post('/upload', authenticate, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const { title, description, tags, is_public, allow_comments, has_ai_badge } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });

  try {
    const filename = `${uuid()}${path.extname(req.file.originalname)}`;
    let fileUrl;

    if (YC_ACCESS_KEY && YC_SECRET_KEY) {
      // Загружаем в Yandex Object Storage
      fileUrl = await uploadToYandex(req.file.buffer, filename, req.file.mimetype);
    } else {
      // Fallback — локальное хранилище
      const fs = await import('fs');
      const uploadDir = './uploads/videos';
      if (!fs.default.existsSync(uploadDir)) fs.default.mkdirSync(uploadDir, { recursive: true });
      fs.default.writeFileSync(`${uploadDir}/${filename}`, req.file.buffer);
      fileUrl = `/uploads/videos/${filename}`;
    }

    const id = uuid();
    const parsedTags = (() => { try { return tags ? JSON.stringify(JSON.parse(tags)) : '[]'; } catch { return JSON.stringify((tags||'').split(',').map(t=>t.trim()).filter(Boolean)); } })();
    db.prepare('INSERT INTO videos (id,user_id,title,description,file_path,tags,is_public,allow_comments,has_ai_badge,file_size) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, req.user.id, title, description||null, fileUrl,
      parsedTags, is_public!=='false'?1:0, allow_comments!=='false'?1:0, has_ai_badge?1:0, req.file.size
    );
    res.status(201).json({ video: fmt(db.prepare('SELECT * FROM videos WHERE id=?').get(id), req.user.id) });
  } catch(e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки: ' + e.message });
  }
});

router.get('/feed', optionalAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)||1);
  const limit = Math.min(50, parseInt(req.query.limit)||10);
  const videos = db.prepare(`SELECT * FROM videos WHERE status='published' AND is_public=1 ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, (page-1)*limit);
  const total  = db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='published' AND is_public=1`).get().c;
  res.json({ videos: videos.map(v => fmt(v, req.user?.id)), pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
});

router.get('/user/:userId', optionalAuth, (req, res) => {
  const videos = db.prepare(`SELECT * FROM videos WHERE user_id=? AND status='published' AND is_public=1 ORDER BY created_at DESC`).all(req.params.userId);
  res.json({ videos: videos.map(v => fmt(v, req.user?.id)) });
});

router.get('/:id', optionalAuth, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  db.prepare('UPDATE videos SET views=views+1 WHERE id=?').run(video.id);
  db.prepare('INSERT INTO video_views (id,video_id,user_id) VALUES (?,?,?)').run(uuid(), video.id, req.user?.id||null);
  res.json({ video: fmt({ ...video, views: video.views+1 }, req.user?.id) });
});

router.delete('/:id', authenticate, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  if (video.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('DELETE FROM videos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/like', authenticate, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const existing = db.prepare('SELECT id FROM likes WHERE user_id=? AND video_id=?').get(req.user.id, video.id);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id=?').run(existing.id);
    db.prepare('UPDATE videos SET likes_count=likes_count-1 WHERE id=?').run(video.id);
    return res.json({ liked: false, likes: Math.max(0, video.likes_count-1) });
  }
  db.prepare('INSERT INTO likes (id,user_id,video_id) VALUES (?,?,?)').run(uuid(), req.user.id, video.id);
  db.prepare('UPDATE videos SET likes_count=likes_count+1 WHERE id=?').run(video.id);
  res.json({ liked: true, likes: video.likes_count+1 });
});

router.get('/:id/comments', (req, res) => {
  const comments = db.prepare(`SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON c.user_id=u.id WHERE c.video_id=? ORDER BY c.created_at DESC LIMIT 50`).all(req.params.id);
  res.json({ comments });
});

router.post('/:id/comments', authenticate, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Текст пуст' });
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const id = uuid();
  db.prepare('INSERT INTO comments (id,user_id,video_id,text) VALUES (?,?,?,?)').run(id, req.user.id, video.id, text.trim());
  db.prepare('UPDATE videos SET comments_count=comments_count+1 WHERE id=?').run(video.id);
  const comment = db.prepare(`SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON c.user_id=u.id WHERE c.id=?`).get(id);
  res.status(201).json({ comment });
});

export default router;

router.patch('/:id', authenticate, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  if (video.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
  const { title, description, tags } = req.body;
  const parsedTags = tags
    ? (() => { try { return JSON.stringify(JSON.parse(tags)); } catch { return tags; } })()
    : video.tags;
  db.prepare(`UPDATE videos SET title=COALESCE(?,title), description=COALESCE(?,description), tags=COALESCE(?,tags), updated_at=datetime('now') WHERE id=?`)
    .run(title||null, description||null, parsedTags||null, req.params.id);
  res.json({ video: fmt(db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id), req.user.id) });
});