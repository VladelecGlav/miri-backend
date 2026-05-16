import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { dbGet, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET  || 'miri-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '30d';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://miri-backend-production.up.railway.app';

function makeHandle(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,20) + '_' + Math.random().toString(36).slice(2,6);
}

function makeToken(id) {
  return jwt.sign({ id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ── Обычная регистрация ──────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Заполни все поля' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  try {
    const existing = await dbGet('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email уже используется' });
    const hash = await bcrypt.hash(password, 10);
    const id = uuid();
    await dbRun('INSERT INTO users (id,name,email,password,handle) VALUES ($1,$2,$3,$4,$5)',
      [id, name, email.toLowerCase(), hash, makeHandle(name)]);
    const user = await dbGet('SELECT id,name,email,handle,avatar_url,bio,role,created_at FROM users WHERE id=$1', [id]);
    res.status(201).json({ token: makeToken(id), user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Вход ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Заполни все поля' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    if (!user.password) return res.status(401).json({ error: 'Этот аккаунт создан через Google. Войди через Google.' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
    const { password: _, ...safe } = user;
    res.json({ token: makeToken(user.id), user: safe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Google OAuth — шаг 1: редирект на Google ────────────
router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${BASE_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── Google OAuth — шаг 2: callback ──────────────────────
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=google_cancelled`);
  if (!code)  return res.redirect(`/?error=no_code`);

  try {
    // Обмен code на токен
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BASE_URL}/api/auth/google/callback`,
        grant_type:    'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect(`/?error=token_failed`);

    // Получаем данные пользователя
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.email) return res.redirect(`/?error=no_email`);

    // Находим или создаём пользователя
    let user = await dbGet('SELECT * FROM users WHERE email=$1', [profile.email.toLowerCase()]);
    if (!user) {
      const id = uuid();
      await dbRun(
        'INSERT INTO users (id,name,email,password,handle,avatar_url) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, profile.name || profile.email.split('@')[0], profile.email.toLowerCase(),
         '', makeHandle(profile.name || profile.email), profile.picture || null]
      );
      user = await dbGet('SELECT * FROM users WHERE id=$1', [id]);
    } else if (!user.avatar_url && profile.picture) {
      await dbRun('UPDATE users SET avatar_url=$1 WHERE id=$2', [profile.picture, user.id]);
    }

    const token = makeToken(user.id);
    // Редирект обратно в приложение с токеном
    res.redirect(`/index.html?token=${token}&name=${encodeURIComponent(user.name)}`);
  } catch(e) {
    console.error('Google OAuth error:', e.message);
    res.redirect(`/?error=oauth_failed`);
  }
});

// ── Получить профиль ────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet('SELECT id,name,email,handle,avatar_url,bio,role,created_at FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json({ user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Обновить профиль ────────────────────────────────────
router.patch('/me', authenticate, async (req, res) => {
  const { name, handle, bio, avatar_color } = req.body;
  try {
    if (handle) {
      const ex = await dbGet('SELECT id FROM users WHERE handle=$1 AND id!=$2', [handle, req.user.id]);
      if (ex) return res.status(409).json({ error: 'Хэндл уже занят' });
    }
    await dbRun(
      'UPDATE users SET name=COALESCE($1,name),handle=COALESCE($2,handle),bio=COALESCE($3,bio),avatar_url=COALESCE($4,avatar_url),updated_at=NOW() WHERE id=$5',
      [name||null, handle||null, bio||null, avatar_color||null, req.user.id]
    );
    const user = await dbGet('SELECT id,name,email,handle,avatar_url,bio,role,created_at FROM users WHERE id=$1', [req.user.id]);
    res.json({ user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// POST /api/auth/streak — получить ежедневный бонус
router.post('/streak', authenticate, async (req, res) => {
  try {
    const user = await dbGet(
      'SELECT streak_days, streak_last_date, streak_total_tokens FROM users WHERE id=$1',
      [req.user.id]
    );

    const today = new Date().toISOString().slice(0, 10);
    const lastDate = user?.streak_last_date ? String(user.streak_last_date).slice(0, 10) : null;

    if (lastDate === today) {
      return res.status(400).json({ error: 'Уже получен сегодня', streak: user.streak_days });
    }

    // Проверяем не прервалась ли серия
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const isConsecutive = lastDate === yesterday;
    const newStreak = isConsecutive ? (user.streak_days || 0) + 1 : 1;

    // Бонус токенов — растёт с серией
    let bonus = 1;
    if (newStreak >= 30) bonus = 10;
    else if (newStreak >= 7) bonus = 3;
    else if (newStreak >= 3) bonus = 2;

    // Обновляем пользователя
    await dbRun(
      'UPDATE users SET streak_days=$1, streak_last_date=$2, streak_total_tokens=streak_total_tokens+$3 WHERE id=$4',
      [newStreak, today, bonus, req.user.id]
    );

    // Начисляем токены
    await dbRun('UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [bonus, req.user.id]);
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, bonus, 'streak', 'Ежедневный бонус (день ' + newStreak + ')']
    );

    const balance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]);

    res.json({
      success: true,
      streak: newStreak,
      bonus,
      balance: balance?.balance || 0,
      message: '+' + bonus + ' токенов! День ' + newStreak,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/streak — статус streak
router.get('/streak', authenticate, async (req, res) => {
  try {
    const user = await dbGet(
      'SELECT streak_days, streak_last_date FROM users WHERE id=$1',
      [req.user.id]
    );
    const today = new Date().toISOString().slice(0, 10);
    const lastDate = user?.streak_last_date ? String(user.streak_last_date).slice(0, 10) : null;
    const claimed = lastDate === today;

    res.json({
      streak: user?.streak_days || 0,
      claimed,
      next_bonus: (user?.streak_days || 0) >= 30 ? 10 : (user?.streak_days || 0) >= 7 ? 3 : (user?.streak_days || 0) >= 3 ? 2 : 1,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;