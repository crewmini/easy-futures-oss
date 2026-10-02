-- 고수 통계 초기화 기준 시각 (관리자 전용): 이 시각 이후 마감 거래만 각 지표에 반영 (2026-09-18)
ALTER TABLE copy_master_stats ADD COLUMN roi_since INTEGER NOT NULL DEFAULT 0;      -- 30일 손익·수익률
ALTER TABLE copy_master_stats ADD COLUMN winrate_since INTEGER NOT NULL DEFAULT 0;  -- 승률·거래 수
ALTER TABLE copy_master_stats ADD COLUMN recent_since INTEGER NOT NULL DEFAULT 0;   -- 최근 마감 거래 목록
