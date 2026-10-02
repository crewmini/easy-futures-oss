-- 2026-09-07 점검 반영: 신분증 결정 이력, 약관 버전, 세션 만료 인덱스, UID 유일성
ALTER TABLE users ADD COLUMN kyc_decided_at INTEGER;
ALTER TABLE users ADD COLUMN kyc_decided_by TEXT;
ALTER TABLE users ADD COLUMN terms_version TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_uid ON users(uid);
