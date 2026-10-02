-- 2026-09-07: 비밀번호 초기화(임시 비밀번호 후 변경 강제), 회원 탈퇴(익명화), 마스터 키 교체 대비 key 버전
ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE api_keys ADD COLUMN key_ver INTEGER NOT NULL DEFAULT 1;
ALTER TABLE kyc_docs ADD COLUMN key_ver INTEGER NOT NULL DEFAULT 1;
