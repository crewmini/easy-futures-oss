-- 2026-09-07: 가입 시 거래소 UID·약관 동의, 신분증 인증 상태, 신분증 사진(암호화) 저장
ALTER TABLE users ADD COLUMN uid TEXT;
ALTER TABLE users ADD COLUMN terms_agreed_at INTEGER;
ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN kyc_submitted_at INTEGER;
ALTER TABLE users ADD COLUMN kyc_note TEXT;
CREATE TABLE IF NOT EXISTS kyc_docs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  doc_type TEXT NOT NULL,
  mime TEXT NOT NULL,
  enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
