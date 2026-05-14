import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';
import { PLANS } from '../models/plans.js';

const router = Router();

const YOOKASSA_SHOP_ID  = process.env.YOOKASSA_SHOP_ID  || '';
const YOOKASSA_SECRET   = process.env.YOOKASSA_SECRET   || '';
const BASE_URL          = process.env.BASE_URL || 'https://miri-backend-production.up.railway.app';

// Пакеты токенов для покупки
export const TOKEN_PACKAGES = {
  basic_monthly: {
    id: 'basic_monthly',
    name: 'Basic — 260 токенов',
    description: 'Тариф Basic на 1 месяц · 260 токенов · Midjourney, Kling и другие',
    amount: 890,
    tokens: 260,
    plan: 'basic',
    plan_days: 30,
  },
  tokens_100: {
    id: 'tokens_100',
    name: '100 токенов',
    description: '100 токенов для генераций',
    amount: 190,
    tokens: 100,
    plan: null,
    plan_days: 0,
  },
  tokens_300: {
    id: 'tokens_300',
    name: '300 токенов',
    description: '300 токенов для генераций',
    amount: 499,
    tokens: 300,
    plan: null,
    plan_days: 0,
  },
};

// POST /api/payments/create — создать платёж
router.post('/create', authenticate, async (req, res) => {
  const { package_id } = req.body;
  const pkg = TOKEN_PACKAGES[package_id];
  if (!pkg) return res.status(400).json({ error: 'Неизвестный пакет' });

  try {
    const idempotenceKey = uuid();
    const paymentId = uuid();

    const paymentData = {
      amount: { value: pkg.amount.toFixed(2), currency: 'RUB' },
      confirmation: {
        type: 'redirect',
        return_url: `${BASE_URL}/index.html?payment=success&pid=${paymentId}`,
      },
      capture: true,
      description: pkg.description,
      metadata: {
        user_id:    req.user.id,
        package_id: pkg.id,
        payment_id: paymentId,
      },
    };

    const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET}`).toString('base64');
    const resp = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization':   `Basic ${auth}`,
        'Content-Type':    'application/json',
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(paymentData),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('YooKassa error:', data);
      return res.status(400).json({ error: data.description || 'Ошибка создания платежа' });
    }

    // Сохраняем платёж в БД
    await dbRun(
      `INSERT INTO token_transactions (id,user_id,amount,type,description)
       VALUES ($1,$2,$3,$4,$5)`,
      [paymentId, req.user.id, 0, 'pending', `Ожидание оплаты: ${pkg.name}`]
    );

    res.json({
      confirmation_url: data.confirmation.confirmation_url,
      payment_id: data.id,
    });
  } catch(e) {
    console.error('Payment create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/webhook — вебхук от ЮKassa
router.post('/webhook', async (req, res) => {
  const event = req.body;

  if (event.type !== 'payment.succeeded') {
    return res.json({ ok: true });
  }

  const payment = event.object;
  const meta    = payment.metadata || {};
  const userId  = meta.user_id;
  const pkgId   = meta.package_id;
  const pkg     = TOKEN_PACKAGES[pkgId];

  if (!userId || !pkg) {
    console.error('Webhook: missing metadata', meta);
    return res.json({ ok: true });
  }

  try {
    // Начисляем токены
    const existing = await dbGet('SELECT user_id FROM token_balance WHERE user_id=$1', [userId]);
    if (existing) {
      await dbRun(
        'UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2',
        [pkg.tokens, userId]
      );
    } else {
      await dbRun('INSERT INTO token_balance (user_id,balance) VALUES ($1,$2)', [userId, pkg.tokens]);
    }

    // Пишем транзакцию
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), userId, pkg.tokens, 'purchase', `Оплата: ${pkg.name}`]
    );

    // Активируем подписку если нужно
    if (pkg.plan && pkg.plan_days > 0) {
      const expiresAt = new Date(Date.now() + pkg.plan_days * 24 * 60 * 60 * 1000);
      await dbRun(
        'INSERT INTO subscriptions (id,user_id,plan,expires_at) VALUES ($1,$2,$3,$4)',
        [uuid(), userId, pkg.plan, expiresAt]
      );
    }

    console.log(`✅ Payment success: user=${userId} pkg=${pkgId} tokens=+${pkg.tokens}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payments/packages — список пакетов
router.get('/packages', async (req, res) => {
  res.json({ packages: Object.values(TOKEN_PACKAGES) });
});

export default router;