import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/playlists/user/:userId — плейлисты пользователя
router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const playlists = await dbAll(
      `SELECT p.*, COUNT(pv.id) as videos_count
       FROM playlists p
       LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
       WHERE p.user_id=$1 AND p.is_public=1
       GROUP BY p.id ORDER BY p.created_at DESC`,
      [req.params.userId]
    );

    // Для каждого плейлиста загружаем обложки (первые 3 видео)
    const result = await Promise.all(playlists.map(async pl => {
      const videos = await dbAll(
        `SELECT v.file_path, v.thumbnail_url FROM playlist_videos pv
         JOIN videos v ON v.id=pv.video_id
         WHERE pv.playlist_id=$1 ORDER BY pv.position LIMIT 3`,
        [pl.id]
      );
      return { ...pl, videos_count: parseInt(pl.videos_count||0), covers: videos.map(v => v.thumbnail_url || v.file_path) };
    }));

    res.json({ playlists: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/playlists/:id — плейлист с видео
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Не найден' });

    const videos = await dbAll(
      `SELECT v.*, pv.position FROM playlist_videos pv
       JOIN videos v ON v.id=pv.video_id
       WHERE pv.playlist_id=$1 ORDER BY pv.position`,
      [req.params.id]
    );

    res.json({ playlist: pl, videos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/playlists — создать плейлист
router.post('/', authenticate, async (req, res) => {
  const { name, description, is_public } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const id = uuid();
    await dbRun(
      'INSERT INTO playlists (id,user_id,name,description,is_public) VALUES ($1,$2,$3,$4,$5)',
      [id, req.user.id, name, description||null, is_public!==false?1:0]
    );
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1', [id]);
    res.status(201).json({ playlist: pl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/playlists/:id/videos — добавить видео
router.post('/:id/videos', authenticate, async (req, res) => {
  const { video_id } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id обязателен' });
  try {
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });

    const count = await dbGet('SELECT COUNT(*) as c FROM playlist_videos WHERE playlist_id=$1', [req.params.id]);
    await dbRun(
      'INSERT INTO playlist_videos (id,playlist_id,video_id,position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [uuid(), req.params.id, video_id, parseInt(count?.c||0)]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/playlists/:id — удалить плейлист
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!pl) return res.status(404).json({ error: 'Не найден' });
    await dbRun('DELETE FROM playlists WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;