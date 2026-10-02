-- 2026-09-08 점검 반영: 실행 기록 중복 방지, 신호별 건너뜀 수, 자주 쓰는 조회 인덱스, 봇 설정 변경 이력
DELETE FROM auto_executions WHERE id NOT IN (SELECT MIN(id) FROM auto_executions GROUP BY signal_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_exec_signal_user ON auto_executions(signal_id, user_id);
ALTER TABLE auto_signals ADD COLUMN skipped_count INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_auto_status ON users(auto_status);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);
CREATE INDEX IF NOT EXISTS idx_partner_apps_status ON partner_applications(status);
ALTER TABLE bot_settings ADD COLUMN updated_by TEXT;
ALTER TABLE bot_settings ADD COLUMN updated_at INTEGER;
