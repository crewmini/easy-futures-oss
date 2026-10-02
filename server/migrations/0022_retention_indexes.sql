-- 2026-09-18 안정성 2차 (감사 A12·B8·B9·B19·B20·B21): 보존 삭제·팔로워 조회 인덱스, 임시 비밀번호 만료, 로그인 IP 제한
CREATE INDEX IF NOT EXISTS idx_copy_follows_follower ON copy_follows(follower_id, started_at DESC);   -- getLatestFollow 풀스캔 방지 (B19)
CREATE INDEX IF NOT EXISTS idx_copy_events_created ON copy_events(created_at);                        -- 보존 삭제 (B20)
CREATE INDEX IF NOT EXISTS idx_copy_exec_created ON copy_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_auto_exec_created ON auto_executions(created_at);                      -- auto_signals(created_at) 는 0008 에 이미 있음
ALTER TABLE users ADD COLUMN pw_temp_expires_at INTEGER;      -- 관리자 임시 비밀번호 만료 시각 (24시간, B9). NULL = 임시 비밀번호 아님
ALTER TABLE login_attempts ADD COLUMN updated_at INTEGER;     -- 마지막 실패 시각 — 잠기지 않은 오래된 행을 지우는 기준 (B21)
CREATE TABLE IF NOT EXISTS login_ip_attempts (                 -- IP 당 로그인 실패 수 (10분 30회, B8). signup_attempts 와 같은 모양
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
