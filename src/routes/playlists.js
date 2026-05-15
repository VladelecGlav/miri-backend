import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/playlists/user/:userId
router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT p.id, p.name, p.created_at,
        COUNT(pv.id) as videos_count,
        array_agg(v.file_path ORDER BY pv.position) FILTER (WHERE v.id IS NOT NULL) as covers
       FROM playlists p
       LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
       LEFT JOIN videos v ON v.id = pv.video_id
       WHERE p.user_id=$1 AND p.is_public=1
       GROUP BY p.id ORDER BY p.created_at DESC`,
      [req.params.userId]
    );
    res.json({ playlists: rows.map(r => ({
      id: r.id, name: r.name, created_at: r.created_at,
      videos_count: parseInt(r.videos_count||0),
      covers: (r.covers||[]).filter(Boolean).slice(0,3),
    }))});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/playlists/:id — видео плейлиста
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Не найден' });
    const videos = await dbAll(
      `SELECT v.* FROM playlist_videos pv JOIN videos v ON v.id=pv.video_id
       WHERE pv.playlist_id=$1 ORDER BY pv.position`,
      [req.params.id]
    );
    res.json({ playlist: pl, videos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/playlists — создать
router.post('/', authenticate, async (req, res) => {
  const { name, video_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const id = uuid();
    await dbRun(
      'INSERT INTO playlists (id,user_id,name,is_public) VALUES ($1,$2,$3,1)',
      [id, req.user.id, name.trim()]
    );
    // Добавляем видео
    if (Array.isArray(video_ids)) {
      for (let i = 0; i < video_ids.length; i++) {
        await dbRun(
          'INSERT INTO playlist_videos (id,playlist_id,video_id,position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [uuid(), id, video_ids[i], i]
        );
      }
    }
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1', [id]);
    res.status(201).json({ playlist: pl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/playlists/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const pl = await dbGet('SELECT * FROM playlists WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!pl) return res.status(404).json({ error: 'Не найден' });
    await dbRun('DELETE FROM playlists WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;