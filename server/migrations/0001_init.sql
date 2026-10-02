-- easy-futures D1 초기 스키마
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc TEXT NOT NULL,      -- base64 AES-256-GCM 암호문 ({apiKey, apiSecret, memo} JSON)
  iv TEXT NOT NULL,       -- base64 12바이트 IV
  preview TEXT NOT NULL,  -- API 키 앞 6자 + '…' (화면 표시용)
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'paper',
  max_leverage INTEGER NOT NULL DEFAULT 10,
  max_amount_usdt REAL NOT NULL DEFAULT 500,
  usdt_krw REAL NOT NULL DEFAULT 1380
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  login_id TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);
