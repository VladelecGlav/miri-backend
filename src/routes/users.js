import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();
const safe = ({ password, ...u }) => u;

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const users = db.prepare(`SELECT id,name,handle,avatar_url,bio FROM users WHERE name LIKE ? OR handle LIKE ? LIMIT 20`).all(`%${q}%`, `%${q}%`);
  res.json({ users });
});

router.get('/:id', optionalAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const followers_count = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(req.params.id).c;
  const following_count = db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(req.params.id).c;
  const videos_count    = db.prepare("SELECT COUNT(*) as c FROM videos WHERE user_id = ? AND status = 'published'").get(req.params.id).c;
  const is_following    = req.user ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.id) : false;
  res.json({ user: { ...safe(user), followers_count, following_count, videos_count, is_following } });
});

router.post('/:id/follow', authenticate, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Пользователь не найден' });
  const existing = db.prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.id);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE id = ?').run(existing.id);
    return res.json({ following: false });
  }
  db.prepare('INSERT INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)').run(uuid(), req.user.id, req.params.id);
  res.json({ following: true });
});

router.get('/:id/followers', (req, res) => {
  const users = db.prepare(`SELECT u.id,u.name,u.handle,u.avatar_url FROM follows f JOIN users u ON f.follower_id=u.id WHERE f.following_id=? LIMIT 100`).all(req.params.id);
  res.json({ users });
});

router.get('/:id/following', (req, res) => {
  const users = db.prepare(`SELECT u.id,u.name,u.handle,u.avatar_url FROM follows f JOIN users u ON f.following_id=u.id WHERE f.follower_id=? LIMIT 100`).all(req.params.id);
  res.json({ users });
});

export default router;
