import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Локальное хранилище
const uploadDir = './uploads/videos';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 500*1024*1024 } });

function fmt(v, viewerId) {
  const author = dbGet('SELECT id,name,handle,avatar_url FROM users WHERE id=$1', [v.user_id]) || {};
  const liked  = viewerId ? !!dbGet('SELECT 1 FROM likes WHERE user_id=$1 AND video_id=$2', [viewerId, v.id]) : false;
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
router.post('/upload', authenticate, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const { title, description, tags, is_public, allow_comments, has_ai_badge } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const id = uuid();
    const fileUrl = `/uploads/videos/${req.file.filename}`;
    const parsedTags = (() => { try { return tags ? JSON.stringify(JSON.parse(tags)) : '[]'; } catch { return JSON.stringify((tags||'').split(',').map(t=>t.trim()).filter(Boolean)); } })();
    dbRun(
      'INSERT INTO videos (id,user_id,title,description,file_path,tags,is_public,allow_comments,has_ai_badge,file_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, req.user.id, title, description||null, fileUrl, parsedTags,
       is_public!=='false'?1:0, allow_comments!=='false'?1:0, has_ai_badge?1:0, req.file.size]
    );
    const video = dbGet('SELECT * FROM videos WHERE id=$1', [id]);
    res.status(201).json({ video: fmt(video, req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/feed
router.get('/feed', optionalAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)||1);
  const limit = Math.min(50, parseInt(req.query.limit)||10);
  try {
    const videos = dbAll(`SELECT * FROM videos WHERE status='published' AND is_public=1 ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, (page-1)*limit]);
    const total  = dbGet(`SELECT COUNT(*) as c FROM videos WHERE status='published' AND is_public=1`);
    res.json({ videos: videos.map(v => fmt(v, req.user?.id)), pagination: { page, limit, total: parseInt(total?.c||0), pages: Math.ceil(parseInt(total?.c||0)/limit) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/subscriptions
router.get('/subscriptions', authenticate, (req, res) => {
  try {
    const videos = dbAll(
      `SELECT v.* FROM videos v JOIN follows f ON f.following_id=v.user_id
       WHERE f.follower_id=$1 AND v.status='published' AND v.is_public=1
       ORDER BY v.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ videos: videos.map(v => fmt(v, req.user.id)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/user/:userId
router.get('/user/:userId', optionalAuth, (req, res) => {
  try {
    const videos = dbAll(`SELECT * FROM videos WHERE user_id=$1 AND status='published' AND is_public=1 ORDER BY created_at DESC`, [req.params.userId]);
    res.json({ videos: videos.map(v => fmt(v, req.user?.id)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/:id
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const video = dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    dbRun('UPDATE videos SET views=views+1 WHERE id=$1', [video.id]);
    dbRun('INSERT INTO video_views (id,video_id,user_id) VALUES ($1,$2,$3)', [uuid(), video.id, req.user?.id||null]);
    res.json({ video: fmt({ ...video, views: parseInt(video.views)+1 }, req.user?.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/videos/:id
router.patch('/:id', authenticate, (req, res) => {
  try {
    const video = dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    const { title, description, tags } = req.body;
    const parsedTags = tags ? (() => { try { return JSON.stringify(JSON.parse(tags)); } catch { return JSON.stringify(tags.split(',').map(t=>t.trim())); } })() : video.tags;
    dbRun('UPDATE videos SET title=COALESCE($1,title), description=COALESCE($2,description), tags=$3, updated_at=datetime(\'now\') WHERE id=$4',
      [title||null, description||null, parsedTags, req.params.id]);
    const updated = dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    res.json({ video: fmt(updated, req.user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/videos/:id
router.delete('/:id', authenticate, (req, res) => {
  try {
    const video = dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    if (video.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    dbRun('DELETE FROM videos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/videos/:id/like
router.post('/:id/like', authenticate, (req, res) => {
  try {
    const video = dbGet('SELECT id FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    const existing = dbGet('SELECT id FROM likes WHERE user_id=$1 AND video_id=$2', [req.user.id, req.params.id]);
    if (existing) {
      dbRun('DELETE FROM likes WHERE user_id=$1 AND video_id=$2', [req.user.id, req.params.id]);
      dbRun('UPDATE videos SET likes_count=MAX(0,likes_count-1) WHERE id=$1', [req.params.id]);
      return res.json({ liked: false });
    }
    dbRun('INSERT INTO likes (id,user_id,video_id) VALUES ($1,$2,$3)', [uuid(), req.user.id, req.params.id]);
    dbRun('UPDATE videos SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
    res.json({ liked: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/videos/:id/comments
router.get('/:id/comments', optionalAuth, (req, res) => {
  try {
    const comments = dbAll(
      `SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.video_id=$1 ORDER BY c.created_at DESC`,
      [req.params.id]
    );
    res.json({ comments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/videos/:id/comments
router.post('/:id/comments', authenticate, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Текст обязателен' });
  try {
    const id = uuid();
    dbRun('INSERT INTO comments (id,user_id,video_id,text) VALUES ($1,$2,$3,$4)', [id, req.user.id, req.params.id, text.trim()]);
    dbRun('UPDATE videos SET comments_count=comments_count+1 WHERE id=$1', [req.params.id]);
    const comment = dbGet(
      `SELECT c.*,u.name,u.handle,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id]
    );
    res.status(201).json({ comment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;