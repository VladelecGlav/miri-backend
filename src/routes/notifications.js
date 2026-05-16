import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const ONESIGNAL_APP_ID  = 'e7de7fa9-98c9-461e-af88-2b0ce053bfcb';
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

async function sendPush(userId, title, message) {
  if (!ONESIGNAL_API_KEY) return;
  try {
    const r = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Authorization': 'Key ' + ONESIGNAL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [userId] },
        target_channel: 'push',
        headings: { en: title, ru: title },
        contents: { en: message, ru: message },
      }),
    });
    const d = await r.json();
    console.log('Push sent:', d.id || d.errors);
  } catch(e) { console.error('Push error:', e.message); }
}

export async function createNotification({ userId, type, fromId, videoId, text }) {
  if (userId === fromId) return;
  try {
    await dbRun(
      'INSERT INTO notifications (id,user_id,type,from_id,video_id,text) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuid(), userId, type, fromId||null, videoId||null, text||null]
    );
    const from = fromId ? await dbGet('SELECT name FROM users WHERE id=$1', [fromId]) : null;
    const fromName = from?.name || 'Кто-то';
    const titles = { like: '❤️ Новый лайк', comment: '💬 Комментарий', follow: '👤 Новый подписчик' };
    await sendPush(userId, titles[type] || '🔔 Miri', fromName + ' ' + (text||''));
  } catch(e) { console.error('createNotification:', e.message); }
}

router.get('/', authenticate, async (req, res) => {
  try {
    const notifs = await dbAll(
      `SELECT n.*, u.name as from_name, u.avatar_url as from_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id=n.from_id
       WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unread = notifs.filter(n => !n.is_read).length;
    res.json({ notifications: notifs, unread });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/read', authenticate, async (req, res) => {
  try {
    await dbRun('UPDATE notifications SET is_read=1 WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/unread', authenticate, async (req, res) => {
  try {
    const r = await dbGet('SELECT COUNT(*) as c FROM notifications WHERE user_id=$1 AND is_read=0', [req.user.id]);
    res.json({ unread: parseInt(r?.c||0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;