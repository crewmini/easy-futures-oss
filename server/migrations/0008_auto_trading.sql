-- 2026-09-07: 자동매매(신호 따라가기)
ALTER TABLE users ADD COLUMN auto_status TEXT NOT NULL DEFAULT 'none';   -- none | pending | approved | suspended
CREATE TABLE IF NOT EXISTS auto_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,          -- 사용자가 켰는지
  pct REAL NOT NULL DEFAULT 10,                -- 신호당 내 돈의 N%
  max_leverage INTEGER NOT NULL DEFAULT 5,
  default_sl_roi REAL NOT NULL DEFAULT 20,     -- 신호에 손절이 없을 때 내 돈 기준 -N%
  agreed_at INTEGER,                           -- 자동매매 위험 동의 시각
  applied_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  note TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS auto_signals (
  id TEXT PRIMARY KEY,                          -- 봇이 준 id (중복 실행 방지)
  source TEXT NOT NULL,                         -- bot | admin
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,                         -- open | close
  direction TEXT,                               -- long | short (open)
  leverage INTEGER,
  sl_roi REAL,
  tp_roi REAL,
  note TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  follower_count INTEGER,
  ok_count INTEGER,
  fail_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auto_signals_created ON auto_signals(created_at);
CREATE TABLE IF NOT EXISTS auto_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,                           -- paper | live
  status TEXT NOT NULL,                         -- ok | skipped | failed
  detail TEXT,
  order_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_exec_user ON auto_executions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auto_exec_signal ON auto_executions(signal_id);
