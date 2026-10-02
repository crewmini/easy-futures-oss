-- 2026-09-08: 저점 카운팅 봇을 Worker 안으로 (hlbot 이식). 감시목록·카운트 체인·평가 워터마크·설정
CREATE TABLE IF NOT EXISTS bot_watchlist (
  coin TEXT NOT NULL,
  tf   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (coin, tf)
);
CREATE TABLE IF NOT EXISTS bot_counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  tf         TEXT NOT NULL,
  seq        INTEGER NOT NULL,            -- 1, 2, 3
  ts_ms      INTEGER NOT NULL,            -- 저점 캔들 open time (UTC ms)
  low        REAL NOT NULL,
  status     TEXT NOT NULL,               -- proposed|confirmed|vetoed|cancelled|replaced
  msg_id     INTEGER,                     -- 텔레그램 메시지 id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_counts_active ON bot_counts (coin, tf, status, seq);
CREATE TABLE IF NOT EXISTS bot_watch_state (
  coin          TEXT NOT NULL,
  tf            TEXT NOT NULL,
  last_eval_ms  INTEGER NOT NULL DEFAULT 0,  -- 마지막으로 평가한 봉의 open time (워터마크)
  last_break_ms INTEGER NOT NULL DEFAULT 0,  -- 마지막 이탈 알림 구간 시작 봉
  last_poll_at  INTEGER,                     -- 마지막 평가 시각 (관리자 화면용)
  last_error    TEXT,
  PRIMARY KEY (coin, tf)
);
CREATE TABLE IF NOT EXISTS bot_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
