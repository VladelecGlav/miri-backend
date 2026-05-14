import { Router } from 'express';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Middleware — только для админов
async function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  next();
}

// DELETE /api/admin/videos/:id
router.delete('/videos/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const video = await dbGet('SELECT * FROM videos WHERE id=$1', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Видео не найдено' });
    await dbRun('DELETE FROM videos WHERE id=$1', [req.params.id]);
    console.log('Admin deleted video:', req.params.id, 'by', req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users — список пользователей
router.get('/users', authenticate, adminOnly, async (req, res) => {
  try {
    const users = await dbAll(
      'SELECT id,name,email,handle,role,created_at FROM users ORDER BY created_at DESC LIMIT 100',
      []
    );
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/users/:id/ban — заблокировать пользователя
router.patch('/users/:id/ban', authenticate, adminOnly, async (req, res) => {
  try {
    await dbRun("UPDATE users SET role='banned' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/videos — все видео
router.get('/videos', authenticate, adminOnly, async (req, res) => {
  try {
    const videos = await dbAll(
      `SELECT v.*, u.name as author_name, u.email as author_email 
       FROM videos v JOIN users u ON u.id=v.user_id 
       ORDER BY v.created_at DESC LIMIT 100`,
      []
    );
    res.json({ videos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;