-- 2026-09-18 카피 실거래 개방 전 보강: 운영자 킬 스위치(새 진입만 멈춤) + 주문 client_order_id 추적
ALTER TABLE copy_masters ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;   -- 1 = 이 고수의 새 진입(open/add)을 멈춤 (정리·손절·배율·손실 한도는 계속)
CREATE TABLE IF NOT EXISTS copy_flags (
  key        TEXT PRIMARY KEY,   -- paused_global: '1' 이면 모든 고수의 새 진입 멈춤
  value      TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
ALTER TABLE copy_executions ADD COLUMN client_order_id TEXT;   -- 주문 전에 정한 client_order_id (실행기가 죽어도 거래소에서 체결 여부를 되찾는다)
