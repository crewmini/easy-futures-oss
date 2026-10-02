-- 2026-09-22 카피 운영 안전: 따라하기가 멈출 때 정리하지 못한 포지션 스냅샷, 팔로워 체결가(슬리피지), 고수 정리 사유(강제정리/ADL)
CREATE TABLE IF NOT EXISTS copy_leftovers (           -- 팔로우가 정리 없이 멈출 때(해지 미정리·관리자·손실 한도 일부 실패·키 삭제·모드 전환·고수 중지) 장부에 남아 있던 포지션
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  follow_id   INTEGER NOT NULL,
  follower_id INTEGER NOT NULL,
  master_id   INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  direction   TEXT NOT NULL,
  contracts   REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  sl_price    REAL,
  tp_price    REAL,
  reason      TEXT NOT NULL,       -- CopyStopReason | loss_limit_partial
  created_at  INTEGER NOT NULL,
  acked_at    INTEGER              -- 사용자가 "확인했어요" 를 누른 시각 (NULL = 아직 화면에 띄운다)
);
CREATE INDEX IF NOT EXISTS idx_copy_leftovers_follower ON copy_leftovers (follower_id, acked_at);
CREATE INDEX IF NOT EXISTS idx_copy_leftovers_follow ON copy_leftovers (follow_id);
ALTER TABLE copy_executions ADD COLUMN fill_price REAL;   -- 팔로워 체결 평균가 (open/add/close 성공 시). 이벤트 price 와 비교해 슬리피지
ALTER TABLE copy_events ADD COLUMN close_reason TEXT;     -- close 이벤트만: liquidation | adl | normal (감시 DO 가 팬아웃 뒤 최선 노력으로 채움, NULL = 미분류)
