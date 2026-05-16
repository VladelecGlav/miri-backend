import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
// Push handled in utils/notify.js
function _unused() {
  if (!ONESIGNAL_API_KEY) return;
  try {
    const r = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Authorization': 'Key ' + ONESIGNAL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [String(userId)] },
        target_channel: 'push',
        headings: { en: title, ru: title },
        contents: { en: message, ru: message },
      }),
    });
    const d = await r.json();
    console.log('Push sent:', d.id || JSON.stringify(d.errors));
  } catch(e) { console.error('Push error:', e.message); }
}

// createNotification is in utils/notify.js

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