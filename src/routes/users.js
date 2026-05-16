import { Router } from 'express';
import { createNotification } from './notifications.js';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

router.get('/search', optionalAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  try {
    const users = await dbAll(
      `SELECT id,name,handle,avatar_url,bio FROM users WHERE name ILIKE $1 OR handle ILIKE $1 LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const user = await dbGet('SELECT id,name,handle,avatar_url,bio,created_at FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    const [followers, following, videosCount] = await Promise.all([
      dbGet('SELECT COUNT(*) as c FROM follows WHERE following_id=$1', [user.id]),
      dbGet('SELECT COUNT(*) as c FROM follows WHERE follower_id=$1', [user.id]),
      dbGet("SELECT COUNT(*) as c FROM videos WHERE user_id=$1 AND status='published'", [user.id]),
    ]);
    let isFollowing = false;
    if (req.user) {
      const f = await dbGet('SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2', [req.user.id, user.id]);
      isFollowing = !!f;
    }
    res.json({ user: { ...user,
      followers_count: parseInt(followers?.c||0),
      following_count: parseInt(following?.c||0),
      videos_count: parseInt(videosCount?.c||0),
      is_following: isFollowing,
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/follow', authenticate, async (req, res) => {
  const followingId = req.params.id;
  if (followingId === req.user.id) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
  try {
    const target = await dbGet('SELECT id FROM users WHERE id=$1', [followingId]);
    if (!target) return res.status(404).json({ error: 'Не найден' });
    const existing = await dbGet('SELECT id FROM follows WHERE follower_id=$1 AND following_id=$2', [req.user.id, followingId]);
    if (existing) {
      await dbRun('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2', [req.user.id, followingId]);
      return res.json({ following: false });
    }
    await dbRun('INSERT INTO follows (id,follower_id,following_id) VALUES ($1,$2,$3)', [uuid(), req.user.id, followingId]);
    await createNotification({ userId: followingId, type: 'follow', fromId: req.user.id, text: 'подписался на тебя' });
    res.json({ following: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/followers', optionalAuth, async (req, res) => {
  try {
    const users = await dbAll(
      `SELECT u.id,u.name,u.handle,u.avatar_url FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=$1`,
      [req.params.id]
    );
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/following', optionalAuth, async (req, res) => {
  try {
    const users = await dbAll(
      `SELECT u.id,u.name,u.handle,u.avatar_url FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=$1`,
      [req.params.id]
    );
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;