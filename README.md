# Miri Backend API

Node.js + Express бэкенд для платформы ИИ-видео Miri.

## Быстрый старт

```bash
cp .env.example .env
npm install --ignore-scripts
npm run dev
```

Сервер поднимется на `http://localhost:3000`

---

## Структура

```
src/
├── index.js              — точка входа, Express, rate limiting
├── models/
│   └── migrate.js        — JSON-база данных (find/filter/insert/update/remove)
├── middleware/
│   └── auth.js           — JWT аутентификация
└── routes/
    ├── auth.js           — регистрация, вход, профиль
    ├── videos.js         — загрузка, лента, лайки, комментарии
    └── users.js          — профили, подписки, поиск
uploads/
└── videos/               — загруженные видеофайлы
```

---

## API

### Auth

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| GET  | `/api/auth/me` | Мой профиль |
| PATCH | `/api/auth/me` | Обновить профиль |

```json
POST /api/auth/register
{ "name": "Андрей", "email": "a@mail.ru", "password": "secret123" }
→ { "token": "eyJ...", "user": { ... } }
```

Все защищённые маршруты: `Authorization: Bearer <token>`

---

### Videos

| Метод | URL | Auth | Описание |
|-------|-----|------|----------|
| GET  | `/api/videos/feed` | — | Лента видео |
| POST | `/api/videos/upload` | ✓ | Загрузить видео |
| GET  | `/api/videos/:id` | — | Одно видео |
| PATCH | `/api/videos/:id` | ✓ | Редактировать |
| DELETE | `/api/videos/:id` | ✓ | Удалить |
| POST | `/api/videos/:id/like` | ✓ | Лайк / анлайк |
| GET  | `/api/videos/:id/comments` | — | Комментарии |
| POST | `/api/videos/:id/comments` | ✓ | Добавить комментарий |
| DELETE | `/api/videos/:id/comments/:commentId` | ✓ | Удалить комментарий |
| GET  | `/api/videos/user/:userId` | — | Видео пользователя |

**Загрузка (multipart/form-data):**
```
video           — файл MP4/MOV, до 500 МБ
title           — название (обязательно)
description     — описание
tags            — ["#пейзажи"] или строка через запятую
is_public       — true/false
allow_comments  — true/false
has_ai_badge    — true/false
```

---

### Users

| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/api/users/search?q=...` | Поиск |
| GET  | `/api/users/:id` | Профиль |
| POST | `/api/users/:id/follow` | Подписаться / отписаться |
| GET  | `/api/users/:id/followers` | Подписчики |
| GET  | `/api/users/:id/following` | Подписки |

---

## Переход на продакшн

1. **БД** → заменить JSON на PostgreSQL (установить `pg` или Prisma)
2. **Хранилище** → заменить `uploads/` на AWS S3 / Cloudflare R2
3. **JWT_SECRET** → случайная строка 64+ символа
4. **HTTPS** → nginx + Let's Encrypt
