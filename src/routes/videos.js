import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import FormDataNode from 'form-data';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

const KINESCOPE_TOKEN   = process.env.KINESCOPE_TOKEN || '';
const KINESCOPE_PROJECT = process.env.KINESCOPE_PROJECT || '';
const KINESCOPE_API     = 'https://api.kinescope.io/v1';

async function uploadToKinescope(buffer, filename, title) {
  // 1. Создаём видео в Kinescope
  const createRes = await fetch(`${KINESCOPE_API}/videos`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KINESCOPE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: KINESCOPE_PROJECT,
      title: title || filename,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Kinescope create error: ${err}`);
  }

  const { data: video } = await createRes.json();
  const videoId = video.id;

  // 2. Получаем URL для загрузки
  const uploadRes = await fetch(`${KINESCOPE_API}/videos/${videoId}/upload`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${KINESCOPE_TOKEN}` },
  });

  if (!uploadRes.ok) throw new Error('Kinescope upload URL error');
  const { data: uploadData } = await uploadRes.json();

  // 3. Загружаем файл через multipart
  const fd = new FormDataNode();
  fd.append('file', buffer, { filename, contentType: 'video/mp4' });

  const putRes = await fetch(uploadData.upload_url, {
    method: 'PUT',
    headers: fd.getHeaders(),
    body: fd,
  });

  if (!putRes.ok) throw new Error(`Kinescope put error: ${putRes.status}`);

  // Возвращаем URL для воспроизведения
  return {
    fileUrl: `https://kinescope.io/${videoId}`,
    embedUrl: `https://kinescope.io/embed/${videoId}`,
    videoId,
  };
}

// Multer в память
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

router.post('/upload', authenticate, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const { title, description, tags, is_public, allow_comments, has_ai_badge } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  try {
    let fileUrl;
    let fileSize = req.file.size;

    if (KINESCOPE_TOKEN && KINESCOPE_PROJECT) {
      // Загружаем в Kinescope
      const result = await uploadToKinescope(req.file.buffer, req.file.originalname, title);
      fileUrl = result.fileUrl;
    } else {
      // Fallback — локальный диск
      const dir = './uploads/videos';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = `${uuid()}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(`${dir}/${filename}`, req.file.buffer);
      fileUrl = `/uploads/videos/${filename}`;
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
    res.json({ videos: await Promise.all(videos.map(v => fmt(v, req.user.id))) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const videos = await dbAll(`SELECT * FROM videos WHERE user_id=$1 AND status='published' AND is_public=1 ORDER BY created_at DESC`, [req.params.userId]);
    res.json({ videos: await Promise.all(videos.map(v => fmt(v, req.user?.id))) });
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