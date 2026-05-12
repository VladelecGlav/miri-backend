import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

const YC_BUCKET     = process.env.YC_BUCKET     || 'miri-videos';
const YC_ACCESS_KEY = process.env.YC_ACCESS_KEY  || '';
const YC_SECRET_KEY = process.env.YC_SECRET_KEY  || '';
const YC_REGION     = 'ru-central1';
const YC_HOST       = 'storage.yandexcloud.net';

// Генерация presigned URL для прямой загрузки с браузера
function getPresignedUrl(key, mimetype, expiresIn = 900) {
  const now    = new Date();
  const date   = now.toISOString().slice(0,10).replace(/-/g,'');
  const time   = now.toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
  const expiry = expiresIn;

  const credScope  = `${date}/${YC_REGION}/s3/aws4_request`;
  const credential = `${YC_ACCESS_KEY}/${credScope}`;

  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    credential,
    'X-Amz-Date':          time,
    'X-Amz-Expires':       String(expiry),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonicalRequest = [
    'PUT',
    `/${key}`,
    queryParams.toString(),
    `host:${YC_HOST}
`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('
');

  const strToSign = [
    'AWS4-HMAC-SHA256',
    time,
    credScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('
');

  const sign = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const signingKey = sign(sign(sign(sign(`AWS4${YC_SECRET_KEY}`, date), YC_REGION), 's3'), 'aws4_request');
  const signature  = crypto.createHmac('sha256', signingKey).update(strToSign).digest('hex');

  queryParams.append('X-Amz-Signature', signature);
  return `https://${YC_HOST}/${key}?${queryParams.toString()}`;
}

// Multer для локального fallback
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500*1024*1024 },
});

async function fmt(v, viewerId) {
  const author = await dbGet('SELECT id,name,handle,avatar_url FROM users WHERE id=$1', [v.user_id]) || {};
  const liked = viewerId ? !!(await dbGet('SELECT 1 FROM likes WHERE user_id=$1 AND video_id=$2', [viewerId, v.id])) : false;
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

// GET /api/videos/presign — получить presigned URL для загрузки в Yandex S3
router.get('/presign', authenticate, async (req, res) => {
  const { filename, mimetype } = req.query;
  if (!filename || !mimetype) return res.status(400).json({ error: 'filename и mimetype обязательны' });

  if (!YC_ACCESS_KEY || !YC_SECRET_KEY) {
    return res.status(400).json({ error: 'S3 не настроен' });
  }

  const key = `videos/${uuid()}${path.extname(filename)}`;
  const uploadUrl = getPresignedUrl(key, mimetype);
  const publicUrl = `https://${YC_HOST}/${YC_BUCKET}/${key.split('/').pop()}`;

  res.json({ uploadUrl, publicUrl, key });
});

router.post('/upload', authenticate, upload.single('video'), async (req, res) => {
  // Поддерживаем два варианта: file_url (уже загружено в S3) или file (локальная загрузка)
  const { title, description, tags, is_public, allow_comments, has_ai_badge, file_url: s3Url } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  if (!req.file && !s3Url) return res.status(400).json({ error: 'Файл не загружен' });
  try {
    let fileUrl;
    let fileSize = 0;

    if (s3Url) {
      // Видео уже загружено напрямую в S3 с фронтенда
      fileUrl = s3Url;
    } else {
      // Локальная загрузка через сервер (fallback)
      const filename = `${uuid()}${path.extname(req.file.originalname)}`;
      const dir = './uploads/videos';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/${filename}`, req.file.buffer);
      fileUrl = `/uploads/videos/${filename}`;
      fileSize = req.file.size;
    }

    const id = uuid();
    const parsedTags = (() => { try { return tags ? JSON.stringify(JSON.parse(tags)) : '[]'; } catch { return JSON.stringify((tags||'').split(',').map(t=>t.trim()).filter(Boolean)); } })();
    await dbRun(
      'INSERT INTO videos (id,user_id,title,description,file_path,tags,is_public,allow_comments,has_ai_badge,file_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, req.user.id, title, description||null, fileUrl, parsedTags,
       is_public!=='false'?1:0, allow_comments!=='false'?1:0, has_ai_badge?1:0, fileSize]
    );
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [id]);
    res.status(201).json({ video: await fmt(video, req.user.id) });
  } catch(e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/feed', optionalAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page)||1);
  const limit = Math.min(50, parseInt(req.query.limit)||10);
  try {
    const [videos, total] = await Promise.all([
      dbAll(`SELECT * FROM videos WHERE status='published' AND is_public=1 ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, (page-1)*limit]),
      dbGet(`SELECT COUNT(*) as c FROM videos WHERE status='published' AND is_public=1`),
    ]);
    const formatted = await Promise.all(videos.map(v => fmt(v, req.user?.id)));
    res.json({ videos: formatted, pagination: { page, limit, total: parseInt(total?.c||0), pages: Math.ceil(parseInt(total?.c||0)/limit) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/subscriptions', authenticate, async (req, res) => {
  try {
    const videos = await dbAll(
      `SELECT v.* FROM videos v JOIN follows f ON f.following_id=v.user_id WHERE f.follower_id=$1 AND v.status='published' AND v.is_public=1 ORDER BY v.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    const formatted = await Promise.all(videos.map(v => fmt(v, req.user.id)));
    res.json({ videos: formatted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const videos = await dbAll(`SELECT * FROM videos WHERE user_id=$1 AND status='published' AND is_public=1 ORDER BY created_at DESC`, [req.params.userId]);
    const formatted = await Promise.all(videos.map(v => fmt(v, req.user?.id)));
    res.json({ videos: formatted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Не найдено' });
    await dbRun('UPDATE videos SET views=views+1 WHERE id=$1', [video.id]);
    res.json({ video: await fmt({ ...video, views: parseInt(video.views)+1 }, req.user?.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    const { title, description, tags } = req.body;
    const parsedTags = tags ? (() => { try { return JSON.stringify(JSON.parse(tags)); } catch { return JSON.stringify(tags.split(',').map(t=>t.trim())); } })() : video.tags;
    await dbRun('UPDATE videos SET title=COALESCE($1,title),description=COALESCE($2,description),tags=$3,updated_at=NOW() WHERE id=$4',
      [title||null, description||null, parsedTags, req.params.id]);
    const updated = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    res.json({ video: await fmt(updated, req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    await dbRun('DELETE FROM videos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/like', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT id FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Не найдено' });
    const existing = await dbGet('SELECT id FROM likes WHERE user_id=$1 AND video_id=$2', [req.user.id, req.params.id]);
    if (existing) {
      await dbRun('DELETE FROM likes WHERE user_id=$1 AND video_id=$2', [req.user.id, req.params.id]);
      await dbRun('UPDATE videos SET likes_count=GREATEST(0,likes_count-1) WHERE id=$1', [req.params.id]);
      return res.json({ liked: false });
    }
    await dbRun('INSERT INTO likes (id,user_id,video_id) VALUES ($1,$2,$3)', [uuid(), req.user.id, req.params.id]);
    await dbRun('UPDATE videos SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
    res.json({ liked: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/comments', optionalAuth, async (req, res) => {
  try {
    const comments = await dbAll(
      `SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.video_id=$1 ORDER BY c.created_at DESC`,
      [req.params.id]
    );
    res.json({ comments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/comments', authenticate, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Текст обязателен' });
  try {
    const id = uuid();
    await dbRun('INSERT INTO comments (id,user_id,video_id,text) VALUES ($1,$2,$3,$4)', [id, req.user.id, req.params.id, text.trim()]);
    await dbRun('UPDATE videos SET comments_count=comments_count+1 WHERE id=$1', [req.params.id]);
    const comment = await dbGet(`SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id]);
    res.status(201).json({ comment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;