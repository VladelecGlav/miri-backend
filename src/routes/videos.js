import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// ── Yandex Object Storage ────────────────────────────────
const YC_BUCKET     = process.env.YC_BUCKET     || 'miri-videos';
const YC_ACCESS_KEY = process.env.YC_ACCESS_KEY || '';
const YC_SECRET_KEY = process.env.YC_SECRET_KEY || '';
const YC_ENDPOINT   = 'https://storage.yandexcloud.net';
const YC_REGION     = 'ru-central1';

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
  const hdrs = { 'content-type': mimetype, 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': time };
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = Object.entries(hdrs).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}:${v}`).join('\n')+'\n';
  const canonicalRequest = ['PUT',`/${key}`,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const credScope = `${date}/${YC_REGION}/s3/aws4_request`;
  const strToSign = ['AWS4-HMAC-SHA256',time,credScope,sha256hex(canonicalRequest)].join('\n');
  const signingKey = sign(sign(sign(sign(`AWS4${YC_SECRET_KEY}`,date),YC_REGION),'s3'),'aws4_request');
  const signature  = hex(sign(signingKey,strToSign));
  const authHeader = `AWS4-HMAC-SHA256 Credential=${YC_ACCESS_KEY}/${credScope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const url = `${YC_ENDPOINT}/${YC_BUCKET}/${key}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { ...hdrs, 'Authorization': authHeader, 'Content-Length': buffer.length },
    body: buffer,
  });
  if (!resp.ok) throw new Error(`Yandex S3 ${resp.status}: ${await resp.text()}`);
  return `${YC_ENDPOINT}/${YC_BUCKET}/${key}`;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500*1024*1024 } });

// Форматирование видео
async function fmt(v, viewerId) {
  const author = await dbGet('SELECT id,name,handle,avatar_url FROM users WHERE id=$1', [v.user_id]) || {};
  const liked  = viewerId ? !!(await dbGet('SELECT 1 FROM likes WHERE user_id=$1 AND video_id=$2', [viewerId, v.id])) : false;
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

// POST /api/videos/upload
router.post('/upload', authenticate, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const { title, description, tags, is_public, allow_comments, has_ai_badge } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const filename = `${uuid()}${path.extname(req.file.originalname)}`;
    let fileUrl;
    if (YC_ACCESS_KEY && YC_SECRET_KEY) {
      fileUrl = await uploadToYandex(req.file.buffer, filename, req.file.mimetype);
    } else {
      const fs = await import('fs');
      const dir = './uploads/videos';
      if (!fs.default.existsSync(dir)) fs.default.mkdirSync(dir, { recursive: true });
      fs.default.writeFileSync(`${dir}/${filename}`, req.file.buffer);
      fileUrl = `/uploads/videos/${filename}`;
    }
    const id = uuid();
    const parsedTags = (() => { try { return tags ? JSON.stringify(JSON.parse(tags)) : '[]'; } catch { return JSON.stringify((tags||'').split(',').map(t=>t.trim()).filter(Boolean)); } })();
    await dbRun(
      'INSERT INTO videos (id,user_id,title,description,file_path,tags,is_public,allow_comments,has_ai_badge,file_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, req.user.id, title, description||null, fileUrl, parsedTags,
       is_public!=='false'?1:0, allow_comments!=='false'?1:0, has_ai_badge?1:0, req.file.size]
    );
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [id]);
    res.status(201).json({ video: await fmt(video, req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/feed
router.get('/feed', optionalAuth, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)||1);
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

// GET /api/videos/subscriptions
router.get('/subscriptions', authenticate, async (req, res) => {
  try {
    const videos = await dbAll(
      `SELECT v.* FROM videos v JOIN follows f ON f.following_id=v.user_id
       WHERE f.follower_id=$1 AND v.status='published' AND v.is_public=1
       ORDER BY v.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    const formatted = await Promise.all(videos.map(v => fmt(v, req.user.id)));
    res.json({ videos: formatted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/user/:userId
router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const videos = await dbAll(
      `SELECT * FROM videos WHERE user_id=$1 AND status='published' AND is_public=1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    const formatted = await Promise.all(videos.map(v => fmt(v, req.user?.id)));
    res.json({ videos: formatted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    await dbRun('UPDATE videos SET views=views+1 WHERE id=$1', [video.id]);
    await dbRun('INSERT INTO video_views (id,video_id,user_id) VALUES ($1,$2,$3)', [uuid(), video.id, req.user?.id||null]);
    res.json({ video: await fmt({ ...video, views: parseInt(video.views)+1 }, req.user?.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/videos/:id
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    const { title, description, tags } = req.body;
    const parsedTags = tags ? (() => { try { return JSON.stringify(JSON.parse(tags)); } catch { return JSON.stringify(tags.split(',').map(t=>t.trim())); } })() : video.tags;
    await dbRun(
      'UPDATE videos SET title=COALESCE($1,title), description=COALESCE($2,description), tags=$3, updated_at=NOW() WHERE id=$4',
      [title||null, description||null, parsedTags, req.params.id]
    );
    const updated = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    res.json({ video: await fmt(updated, req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/videos/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    await dbRun('DELETE FROM videos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/videos/:id/like
router.post('/:id/like', authenticate, async (req, res) => {
  try {
    const video = await dbGet('SELECT id FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
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

// GET /api/videos/:id/comments
router.get('/:id/comments', optionalAuth, async (req, res) => {
  try {
    const comments = await dbAll(
      `SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.video_id=$1 ORDER BY c.created_at DESC`,
      [req.params.id]
    );
    res.json({ comments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/videos/:id/comments
router.post('/:id/comments', authenticate, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Текст обязателен' });
  try {
    const id = uuid();
    await dbRun('INSERT INTO comments (id,user_id,video_id,text) VALUES ($1,$2,$3,$4)', [id, req.user.id, req.params.id, text.trim()]);
    await dbRun('UPDATE videos SET comments_count=comments_count+1 WHERE id=$1', [req.params.id]);
    const comment = await dbGet(
      `SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id]
    );
    res.status(201).json({ comment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;