import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';
import { PLANS } from '../models/plans.js';

const router = Router();

const CP_PUBLIC_ID = process.env.CP_PUBLIC_ID || '';
const CP_SECRET    = process.env.CP_SECRET    || '';
const BASE_URL     = process.env.BASE_URL || 'https://miri-backend-production.up.railway.app';

export const TOKEN_PACKAGES = {
  basic_monthly: {
    id: 'basic_monthly',
    name: 'Basic — 260 токенов',
    description: 'Тариф Basic на 1 месяц · 260 токенов',
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

// GET /api/payments/packages
router.get('/packages', (req, res) => {
  res.json({ packages: Object.values(TOKEN_PACKAGES), public_id: CP_PUBLIC_ID });
});

// POST /api/payments/create — создать заказ и вернуть данные для виджета
router.post('/create', authenticate, async (req, res) => {
  const { package_id } = req.body;
  const pkg = TOKEN_PACKAGES[package_id];
  if (!pkg) return res.status(400).json({ error: 'Неизвестный пакет' });

  try {
    const invoiceId = uuid();

    // Сохраняем pending транзакцию
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [invoiceId, req.user.id, 0, 'pending', `Ожидание: ${pkg.name}`]
    );

    res.json({
      public_id:   CP_PUBLIC_ID,
      amount:      pkg.amount,
      currency:    'RUB',
      description: pkg.description,
      invoice_id:  invoiceId,
      email:       req.user.email || '',
      package_id:  pkg.id,
      user_id:     req.user.id,
    });
  } catch(e) {
    console.error('Payment create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/webhook — уведомление от CloudPayments
router.post('/webhook', async (req, res) => {
  const { TransactionId, Status, InvoiceId, AccountId, Amount, Data } = req.body;

  console.log('CP Webhook:', Status, InvoiceId, AccountId);

  if (Status !== 'Completed') return res.json({ code: 0 });

  // Парсим metadata из Data
  let meta = {};
  try { meta = JSON.parse(Data || '{}'); } catch(e) {}

  const userId    = meta.user_id || AccountId;
  const packageId = meta.package_id;
  const pkg       = TOKEN_PACKAGES[packageId];

  if (!userId || !pkg) {
    console.error('Webhook: missing data', { userId, packageId });
    return res.json({ code: 0 });
  }

  try {
    // Проверяем не обработан ли уже
    const existing = await dbGet(
      "SELECT id FROM token_transactions WHERE id=$1 AND type='purchase'",
      [InvoiceId]
    );
    if (existing) return res.json({ code: 0 });

    // Начисляем токены
    const balance = await dbGet('SELECT user_id FROM token_balance WHERE user_id=$1', [userId]);
    if (balance) {
      await dbRun('UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [pkg.tokens, userId]);
    } else {
      await dbRun('INSERT INTO token_balance (user_id,balance) VALUES ($1,$2)', [userId, pkg.tokens]);
    }

    // Пишем транзакцию
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [InvoiceId || uuid(), userId, pkg.tokens, 'purchase', `Оплата: ${pkg.name}`]
    );

    // Активируем подписку
    if (pkg.plan && pkg.plan_days > 0) {
      const expiresAt = new Date(Date.now() + pkg.plan_days * 24 * 60 * 60 * 1000);
      await dbRun(
        'INSERT INTO subscriptions (id,user_id,plan,expires_at) VALUES ($1,$2,$3,$4)',
        [uuid(), userId, pkg.plan, expiresAt]
      );
    }

    console.log(`✅ Payment OK: user=${userId} pkg=${packageId} +${pkg.tokens} tokens`);
    res.json({ code: 0 }); // 0 = успех для CloudPayments
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ code: 10, message: e.message });
  }
});

export default router;