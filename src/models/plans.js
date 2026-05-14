// ── Конфиг тарифов Miri ──────────────────────────────────

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    tokens_per_month: 0,
    tokens_on_register: 50,
    limits: {
      videos_per_month: 0,
      images_per_month: 10,
      songs_per_month: 0,
      text_per_hour: 3,
      text_per_day: 10,
    },
    models: {
      text:  ['deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct'],
      image: ['pollinations', 'stable-diffusion'],
      video: [],
      voice: [],
    },
  },

  basic: {
    id: 'basic',
    name: 'Basic',
    price: 890,
    tokens_per_month: 260,
    limits: {
      videos_per_month: 43,
      images_per_month: 867,
      songs_per_month: 130,
      text_per_hour: 10,
      text_per_day: 60,
      stable_diffusion: 'unlimited',
    },
    models: {
      text:  [
        'deepseek/deepseek-chat',
        'qwen/qwen-2.5-72b-instruct',
        'gemini-2.5-flash',
        'gpt-4.1-mini',
      ],
      image: [
        'pollinations',
        'stable-diffusion',
        'midjourney',
        'nano-banana-pro',
        'flux/schnell',
      ],
      video: [
        'kling-video/v1.6/standard/text-to-video',
      ],
      voice: [
        'suno-v4',
      ],
    },
  },
};

// Стоимость генераций в токенах
export const TOKEN_COSTS = {
  text:   1,   // 1 токен за текстовый запрос
  image:  3,   // 3 токена за изображение
  video:  6,   // 6 токенов за видео (260/43 ≈ 6)
  voice:  2,   // 2 токена за песню (260/130 = 2)
};

// Проверить доступ к модели по тарифу
export function canUseModel(plan, toolType, modelId) {
  const planConfig = PLANS[plan] || PLANS.free;
  const allowed = planConfig.models[toolType] || [];
  // Pollinations всегда бесплатно
  if (modelId === 'pollinations') return true;
  return allowed.includes(modelId);
}

// Получить план пользователя
export function getPlanName(plan, expiresAt) {
  if (!plan || plan === 'free') return 'free';
  if (expiresAt && new Date(expiresAt) < new Date()) return 'free'; // истёк
  return plan;
}