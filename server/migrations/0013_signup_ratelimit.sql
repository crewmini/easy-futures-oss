-- 2026-09-08: 초대 코드 없이 가입 허용 → IP 당 가입 횟수 제한 (시간당)
CREATE TABLE IF NOT EXISTS signup_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
