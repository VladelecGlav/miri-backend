import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { db } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const sign = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
const safe = ({ password, ...u }) => u;

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Имя, email и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email уже зарегистрирован' });

  const id = uuid();
  const handle = name.toLowerCase().replace(/[^a-z0-9]/gi, '').slice(0, 20) + '_' + id.slice(0, 4);
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id, name, email, password, handle) VALUES (?, ?, ?, ?, ?)').run(id, name, email, hash, handle);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ token: sign(id), user: safe(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный email или пароль' });
  res.json({ token: sign(user.id), user: safe(user) });
});

router.get('/me', authenticate, (req, res) => res.json({ user: safe(req.user) }));

router.patch('/me', authenticate, (req, res) => {
  const { name, bio, handle } = req.body;
  if (handle && db.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').get(handle, req.user.id)) return res.status(409).json({ error: 'Handle уже занят' });
  db.prepare(`UPDATE users SET name=COALESCE(?,name), bio=COALESCE(?,bio), handle=COALESCE(?,handle), updated_at=datetime('now') WHERE id=?`).run(name||null, bio||null, handle||null, req.user.id);
  res.json({ user: safe(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

export default router;