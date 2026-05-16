import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
// Preview stored as S3 URL via existing upload mechanism
async function uploadPreviewToS3(base64Data, filename, mimeType) {
  try {
    const { createS3Client, uploadBufferToS3 } = await import('./s3.js').catch(() => ({}));
    if (uploadBufferToS3) {
      const buffer = Buffer.from(base64Data, 'base64');
      return await uploadBufferToS3(buffer, filename, mimeType);
    }
  } catch(e) {}
  // Fallback: return null if S3 not available
  return null;
}


const router = Router();

// GET /api/trends — все тренды (официальные + пользовательские)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const trends = await dbAll(
      `SELECT t.*, u.name as author_name, u.handle as author_handle
       FROM trends t LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.is_official DESC, t.likes_count DESC, t.created_at DESC
       LIMIT 50`,
      []
    );
    res.json({ trends: trends.map(t => ({
      ...t,
      steps: (() => { try { return JSON.parse(t.steps); } catch { return []; } })(),
      is_official: !!t.is_official,
    }))});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/trends — создать тренд
router.post('/', authenticate, async (req, res) => {
  const { title, emoji, category, difficulty, preview_color, steps, preview_media } = req.body;
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  if (!steps || !Array.isArray(steps) || steps.length === 0)
    return res.status(400).json({ error: 'Добавь хотя бы один шаг' });
  try {
    const id = uuid();
    
    // Upload preview to S3
    let previewUrl = null;
    if (preview_media && preview_media.startsWith('data:')) {
      try {
        const matches = preview_media.match(/^data:([^;]+);base64,(.+)$/);
        if (matches && process.env.S3_ACCESS_KEY) {
          const mimeType = matches[1];
          const base64 = matches[2];
          const ext = mimeType.includes('video') ? 'mp4' : 'jpg';
          previewUrl = await uploadPreviewToS3(base64, 'trends/' + id + '.' + ext, mimeType);
        }
      } catch(e) { console.error('Preview S3 error:', e.message); }
    }
    await dbRun(
      'INSERT INTO trends (id,user_id,title,emoji,category,difficulty,preview_color,steps,is_official,preview_video_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, req.user.id, title, emoji||'✨', category||'Другое',
       difficulty||'Легко', preview_color||'linear-gradient(135deg,#1a1a2e,#4338ca)',
       JSON.stringify(steps), 0, previewUrl]
    );
    const trend = await dbGet('SELECT * FROM trends WHERE id=$1', [id]);
    res.status(201).json({ trend: { ...trend, steps } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/trends/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const trend = await dbGet('SELECT * FROM trends WHERE id=$1', [req.params.id]);
    if (!trend) return res.status(404).json({ error: 'Не найден' });
    if (trend.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    await dbRun('DELETE FROM trends WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/trends/:id/like
router.post('/:id/like', authenticate, async (req, res) => {
  try {
    await dbRun('UPDATE trends SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;