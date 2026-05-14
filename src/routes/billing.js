import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbGet, dbAll, dbRun } from '../models/migrate.js';
import { authenticate } from '../middleware/auth.js';
import { PLANS, TOKEN_COSTS, canUseModel, getPlanName } from '../models/plans.js';

const router = Router();

// Инициализация баланса нового пользователя
export async function initUserTokens(userId) {
  const existing = await dbGet('SELECT user_id FROM token_balance WHERE user_id=$1', [userId]);
  if (!existing) {
    await dbRun('INSERT INTO token_balance (user_id, balance) VALUES ($1, $2)',
      [userId, PLANS.free.tokens_on_register]);
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), userId, PLANS.free.tokens_on_register, 'bonus', 'Приветственные токены']
    );
  }
}

// GET /api/billing/me — баланс и подписка
router.get('/me', authenticate, async (req, res) => {
  try {
    const [balance, sub] = await Promise.all([
      dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]),
      dbGet('SELECT plan, expires_at FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]),
    ]);

    const plan = getPlanName(sub?.plan, sub?.expires_at);
    const planConfig = PLANS[plan] || PLANS.free;

    res.json({
      balance: balance?.balance || 0,
      plan,
      plan_name: planConfig.name,
      expires_at: sub?.expires_at || null,
      models: planConfig.models,
      limits: planConfig.limits,
      plans: Object.values(PLANS).map(p => ({
        id: p.id, name: p.name, price: p.price,
        tokens_per_month: p.tokens_per_month,
        limits: p.limits,
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/billing/transactions — история транзакций
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const txs = await dbAll(
      'SELECT * FROM token_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ transactions: txs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/billing/spend — списать токены (внутренний endpoint)
router.post('/spend', authenticate, async (req, res) => {
  const { tool_type, model_id, description } = req.body;
  if (!tool_type) return res.status(400).json({ error: 'tool_type обязателен' });

  try {
    // Получаем план пользователя
    const sub = await dbGet(
      'SELECT plan, expires_at FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    const plan = getPlanName(sub?.plan, sub?.expires_at);

    // Проверяем доступ к модели
    if (model_id && !canUseModel(plan, tool_type, model_id)) {
      return res.status(403).json({
        error: 'Эта модель недоступна на вашем тарифе',
        required_plan: 'basic',
        upgrade_url: '/plans',
      });
    }

    // Считаем стоимость
    const cost = TOKEN_COSTS[tool_type] || 1;

    // Проверяем баланс
    const balance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]);
    const currentBalance = balance?.balance || 0;

    if (currentBalance < cost) {
      return res.status(402).json({
        error: 'Недостаточно токенов',
        balance: currentBalance,
        cost,
        buy_url: '/plans',
      });
    }

    // Списываем
    await dbRun(
      'UPDATE token_balance SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2',
      [cost, req.user.id]
    );
    await dbRun(
      'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, -cost, 'spend', description || tool_type]
    );

    const newBalance = await dbGet('SELECT balance FROM token_balance WHERE user_id=$1', [req.user.id]);
    res.json({ success: true, cost, balance: newBalance?.balance || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/billing/activate — активировать тариф (тест без оплаты)
router.post('/activate', authenticate, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Неизвестный тариф' });
  if (plan === 'free') return res.status(400).json({ error: 'Free тариф активен по умолчанию' });

  try {
    const planConfig = PLANS[plan];
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 дней

    await dbRun(
      'INSERT INTO subscriptions (id,user_id,plan,expires_at) VALUES ($1,$2,$3,$4)',
      [uuid(), req.user.id, plan, expiresAt]
    );

    // Начисляем токены
    if (planConfig.tokens_per_month > 0) {
      await dbRun(
        'UPDATE token_balance SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2',
        [planConfig.tokens_per_month, req.user.id]
      );
      await dbRun(
        'INSERT INTO token_transactions (id,user_id,amount,type,description) VALUES ($1,$2,$3,$4,$5)',
        [uuid(), req.user.id, planConfig.tokens_per_month, 'purchase', `Тариф ${planConfig.name} — ${planConfig.tokens_per_month} токенов`]
      );
    }

    res.json({ success: true, plan, expires_at: expiresAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;