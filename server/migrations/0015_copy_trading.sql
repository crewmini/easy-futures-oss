-- 카피 트레이딩 (docs/copy-trading.md) 2026-09-18
CREATE TABLE IF NOT EXISTS copy_masters (
  user_id       INTEGER PRIMARY KEY,
  nickname      TEXT NOT NULL,
  intro         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|suspended|rejected
  terms_version TEXT,
  applied_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_masters_nick ON copy_masters (nickname COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_copy_masters_status ON copy_masters (status);

CREATE TABLE IF NOT EXISTS copy_follows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id     INTEGER NOT NULL,
  master_id       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|stopped
  mode            TEXT NOT NULL,                   -- paper|live (시작 당시 모드)
  copy_amount     REAL NOT NULL,                   -- 따라갈 돈 (시작값)
  copy_amount_now REAL NOT NULL,                   -- 실현손익 반영한 현재 따라갈 돈
  loss_limit_pct  REAL NOT NULL,
  max_leverage    INTEGER NOT NULL,
  sl_roi          REAL NOT NULL,
  terms_version   TEXT NOT NULL,
  agreed_at       INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  stopped_at      INTEGER,
  stop_reason     TEXT,
  realized_pnl    REAL NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_follows_active ON copy_follows (follower_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_copy_follows_master ON copy_follows (master_id, status);

CREATE TABLE IF NOT EXISTS copy_master_meta (
  master_id    INTEGER PRIMARY KEY,
  seq          INTEGER NOT NULL DEFAULT 0,
  ws_ok        INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER,
  last_error   TEXT
);
CREATE TABLE IF NOT EXISTS copy_master_state (
  master_id   INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  direction   TEXT,               -- long|short|NULL(없음)
  contracts   REAL NOT NULL DEFAULT 0,
  entry_price REAL,
  leverage    INTEGER,
  equity      REAL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (master_id, symbol)
);

CREATE TABLE IF NOT EXISTS copy_events (
  id               TEXT PRIMARY KEY,       -- copy-<masterId>-<symbol>-<seq>
  master_id        INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  symbol           TEXT NOT NULL,
  kind             TEXT NOT NULL,          -- open|add|reduce|close
  direction        TEXT NOT NULL,
  before_contracts REAL NOT NULL,
  after_contracts  REAL NOT NULL,
  price            REAL NOT NULL,
  leverage         INTEGER NOT NULL,
  master_equity    REAL NOT NULL,
  created_at       INTEGER NOT NULL,
  processed_at     INTEGER,
  follower_count   INTEGER,
  ok_count         INTEGER,
  fail_count       INTEGER,
  skipped_count    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_copy_events_master ON copy_events (master_id, created_at DESC);

CREATE TABLE IF NOT EXISTS copy_executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  follower_id INTEGER NOT NULL,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,               -- ok|failed|skipped
  detail      TEXT,
  order_id    TEXT,
  contracts   REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_exec_unique ON copy_executions (event_id, follower_id);
CREATE INDEX IF NOT EXISTS idx_copy_exec_follower ON copy_executions (follower_id, created_at DESC);

CREATE TABLE IF NOT EXISTS copy_positions (
  follower_id INTEGER NOT NULL,
  master_id   INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  direction   TEXT NOT NULL,
  contracts   REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  opened_at   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_copy_positions_master ON copy_positions (master_id);

CREATE TABLE IF NOT EXISTS copy_master_stats (
  master_id  INTEGER PRIMARY KEY,
  days30_pnl REAL NOT NULL DEFAULT 0,
  days30_roi REAL NOT NULL DEFAULT 0,
  win_rate   REAL NOT NULL DEFAULT 0,
  trades     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
