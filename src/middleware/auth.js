import jwt from 'jsonwebtoken';
import { db } from '../models/migrate.js';

export function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Токен не предоставлен' });
  try {
    const { id } = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

export function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const { id } = jwt.verify(h.slice(7), process.env.JWT_SECRET);
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } catch { /* анонимный */ }
  }
  next();
}
