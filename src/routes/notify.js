import { dbGet, dbRun } from '../models/migrate.js';
import { v4 as uuid } from 'uuid';

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
        include_aliases: { external_id: [String(userId)] },
        target_channel: 'push',
        headings: { en: title, ru: title },
        contents: { en: message, ru: message },
      }),
    });
    const d = await r.json();
    console.log('Push:', d.id || JSON.stringify(d.errors));
  } catch(e) { console.error('Push error:', e.message); }
}

export async function createNotification({ userId, type, fromId, videoId, text }) {
  if (!userId || userId === fromId) return;
  try {
    await dbRun(
      'INSERT INTO notifications (id,user_id,type,from_id,video_id,text) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuid(), userId, type, fromId||null, videoId||null, text||null]
    );
    const from = fromId ? await dbGet('SELECT name FROM users WHERE id=$1', [fromId]) : null;
    const fromName = from?.name || 'Someone';
    const titles = { like: 'New like', comment: 'New comment', follow: 'New follower' };
    await sendPush(userId, titles[type] || 'Miri', fromName + ': ' + (text||''));
  } catch(e) { console.error('createNotification error:', e.message); }
}