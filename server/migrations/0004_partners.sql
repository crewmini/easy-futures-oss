-- 2026-09-07: 제휴사(영업 담당자) — 고유 코드, 고객 연결
CREATE TABLE IF NOT EXISTS partners (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN partner_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_partner ON users(partner_id);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
