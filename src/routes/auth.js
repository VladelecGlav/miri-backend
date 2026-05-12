import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { dbGet, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET  || 'miri-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '30d';

function makeHandle(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,20) + '_' + Math.random().toString(36).slice(2,6);
}

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Заполни все поля' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  try {
    const existing = await dbGet('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email уже используется' });
    const hash = await bcrypt.hash(password, 10);
    const id = uuid();
    const handle = makeHandle(name);
    await dbRun('INSERT INTO users (id,name,email,password,handle) VALUES ($1,$2,$3,$4,$5)',
      [id, name, email.toLowerCase(), hash, handle]);
    const user = await dbGet('SELECT id,name,email,handle,avatar_url,bio,role,created_at FROM users WHERE id=$1', [id]);
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ token, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Заполни все поля' });
  try {
    const user = await dbGet('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const { password: _, ...safe } = user;
    res.json({ token, user: safe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet('SELECT id,name,email,handle,avatar_url,bio,role,created_at FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json({ user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

export default router;