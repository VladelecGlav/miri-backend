import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || 'e7de7fa9-98c9-461e-af88-2b0ce053bfcb';
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Отправка push через OneSignal
async function sendPush({ externalId, title, message, url }) {
  if (!ONESIGNAL_API_KEY) return;
  try {
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Authorization': 'Key ' + ONESIGNAL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [externalId] },
        target_channel: 'push',
        headings: { en: title, ru: title },
        contents: { en: message, ru: message },
        url: url || 'https://vladelecglav-miri-backend-c9e7.twc1.net',
      }),
    });
  } catch(e) { console.error('OneSignal push error:', e.message); }
}

// Хелпер для создания уведомления
export async function createNotification({ userId, type, fromId, videoId, text }) {
  if (userId === fromId) return;
  try {
    await dbRun(
      'INSERT INTO notifications (id,user_id,type,from_id,video_id,text) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuid(), userId, type, fromId || null, videoId || null, text || null]
    );

    // Получаем имя отправителя
    const fromUser = fromId ? await dbGet('SELECT name FROM users WHERE id=$1', [fromId]) : null;
    const fromName = fromUser?.name || 'Кто-то';

    // Отправляем push
    const titles = { like: '❤️ Новый лайк', comment: '💬 Новый комментарий', follow: '👤 Новый подписчик' };
    await sendPush({
      externalId: userId,
      title: titles[type] || '🔔 Miri',
      message: fromName + ' ' + (text || ''),
      url: 'https://vladelecglav-miri-backend-c9e7.twc1.net',
    });
  } catch(e) { console.error('createNotification error:', e.message); }
}

// GET /api/notifications — список уведомлений
router.get('/', authenticate, async (req, res) => {
  try {
    const notifs = await dbAll(
      `SELECT n.*, u.name as from_name, u.avatar_url as from_avatar, u.handle as from_handle,
        v.title as video_title
       FROM notifications n
       LEFT JOIN users u ON u.id = n.from_id
       LEFT JOIN videos v ON v.id = n.video_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC LIMIT 50`,
      [req.user.id]
    );

    const unread = notifs.filter(n => !n.is_read).length;
    res.json({ notifications: notifs, unread });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/read — отметить все как прочитанные
router.post('/read', authenticate, async (req, res) => {
  try {
    await dbRun('UPDATE notifications SET is_read=1 WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/unread — количество непрочитанных
router.get('/unread', authenticate, async (req, res) => {
  try {
    const r = await dbGet('SELECT COUNT(*) as c FROM notifications WHERE user_id=$1 AND is_read=0', [req.user.id]);
    res.json({ unread: parseInt(r?.c || 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;