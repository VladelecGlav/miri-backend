import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// POST /api/promo/activate — активировать промокод
router.post('/activate', authenticate, async (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: 'Введи промокод' });

  try {
    // Находим промокод
    const promo = await dbGet(
      'SELECT * FROM promo_codes WHERE UPPER(code)=UPPER($1)',
      [code.trim()]
    );

    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'Промокод уже использован' });
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Промокод истёк' });
    }

    // Проверяем не использовал ли уже этот пользователь
    const used = await dbGet(
      'SELECT id FROM promo_uses WHERE user_id=$1 AND code_id=$2',
      [req.user.id, promo.id]
    );
    if (used) return res.status(400).json({ error: 'Ты уже использовал этот промокод' });

    // Начисляем токены
    await dbRun(
      'UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2',
      [promo.tokens, req.user.id]
    );

    // Записываем использование
    await dbRun(
      'INSERT INTO promo_uses (id,user_id,code_id) VALUES ($1,$2,$3)',
      [uuid(), req.user.id, promo.id]
    );
    await dbRun(
      'UPDATE promo_codes SET used_count=used_count+1 WHERE id=$1',
      [promo.id]
    );

    // Записываем транзакцию
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, promo.tokens, 'promo', `Промокод: ${promo.code}`]
    );

    const balance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]);

    res.json({
      success: true,
      tokens: promo.tokens,
      balance: balance?.balance || 0,
      message: `+${promo.tokens} токенов начислено!`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/promo/create — создать промокод (только admin)
router.post('/create', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
  const { code, tokens, max_uses, expires_at } = req.body;
  if (!code || !tokens) return res.status(400).json({ error: 'Код и токены обязательны' });
  try {
    await dbRun(
      'INSERT INTO promo_codes (id,code,tokens,max_uses,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), code.toUpperCase(), tokens, max_uses||1, expires_at||null]
    );
    res.status(201).json({ success: true, code: code.toUpperCase() });
  } catch(e) {
    if (e.message.includes('unique')) return res.status(409).json({ error: 'Такой промокод уже существует' });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/promo/list — список промокодов (только admin)
router.get('/list', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
  const { dbAll } = await import('../models/migrate.js');
  const codes = await dbAll('SELECT * FROM promo_codes ORDER BY created_at DESC', []);
  res.json({ codes });
});

export default router;