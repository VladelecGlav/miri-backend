import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

export const dbGet = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
};

export const dbAll = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows;
};

export const dbRun = async (sql, params = []) => {
  return pool.query(sql, params);
};

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, handle TEXT UNIQUE, avatar_url TEXT, bio TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      playlists TEXT DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Add playlists column if not exists (for existing DBs)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS playlists TEXT DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT, file_path TEXT NOT NULL,
      thumbnail_url TEXT, duration REAL DEFAULT 0, file_size BIGINT DEFAULT 0,
      tags TEXT DEFAULT '[]', is_public INTEGER NOT NULL DEFAULT 1,
      allow_comments INTEGER NOT NULL DEFAULT 1, has_ai_badge INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'published', views BIGINT NOT NULL DEFAULT 0,
      likes_count INTEGER NOT NULL DEFAULT 0, comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY, follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(follower_id, following_id)
    );
    CREATE TABLE IF NOT EXISTS video_views (
      id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
    CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
    CREATE INDEX IF NOT EXISTS idx_likes_video ON likes(video_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

    CREATE TABLE IF NOT EXISTS trends (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      emoji       TEXT NOT NULL DEFAULT '✨',
      category    TEXT NOT NULL DEFAULT 'Другое',
      difficulty  TEXT NOT NULL DEFAULT 'Легко',
      preview_color TEXT DEFAULT 'linear-gradient(135deg,#1a1a2e,#4338ca)',
      steps       TEXT NOT NULL DEFAULT '[]',
      is_official INTEGER NOT NULL DEFAULT 0,
      views       INTEGER NOT NULL DEFAULT 0,
      likes_count INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trends_official ON trends(is_official);
    CREATE INDEX IF NOT EXISTS idx_trends_user ON trends(user_id);

    CREATE TABLE IF NOT EXISTS playlists (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      cover_url   TEXT,
      is_public   INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS playlist_videos (
      id          TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(playlist_id, video_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pl_user ON playlists(user_id);
    CREATE INDEX IF NOT EXISTS idx_pl_videos ON playlist_videos(playlist_id);

    -- Подписки и токены
    CREATE TABLE IF NOT EXISTS subscriptions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan            TEXT NOT NULL DEFAULT 'free',
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_balance (
      user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance         INTEGER NOT NULL DEFAULT 50,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_transactions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount          INTEGER NOT NULL,
      type            TEXT NOT NULL,
      description     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON token_transactions(user_id);
  `);
  console.log('✅ Neon PostgreSQL ready');
}