import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { db, now } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const signToken = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
const safe = ({ password, ...u }) => u;

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Имя, email и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (db.find('users', u => u.email === email)) return res.status(409).json({ error: 'Email уже зарегистрирован' });
  const id = uuid();
  const handle = name.toLowerCase().replace(/[^a-z0-9]/gi, '').slice(0, 20) + '_' + id.slice(0, 4);
  const user = { id, name, email, password: await bcrypt.hash(password, 12), handle, avatar_url: null, bio: null, role: 'user', is_partner: false, partner_level: 'bronze', total_views: 0, created_at: now(), updated_at: now() };
  db.insert('users', user);
  res.status(201).json({ token: signToken(id), user: safe(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  const user = db.find('users', u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный email или пароль' });
  res.json({ token: signToken(user.id), user: safe(user) });
});

router.get('/me', authenticate, (req, res) => res.json({ user: safe(req.user) }));

router.patch('/me', authenticate, (req, res) => {
  const { name, bio, handle } = req.body;
  if (handle && db.find('users', u => u.handle === handle && u.id !== req.user.id)) return res.status(409).json({ error: 'Handle занят' });
  db.update('users', u => u.id === req.user.id, { ...(name && { name }), ...(bio !== undefined && { bio }), ...(handle && { handle }) });
  res.json({ user: safe(db.find('users', u => u.id === req.user.id)) });
});

export default router;
