-- 2026-09-07: 제휴사 신청(소속·이름·전화번호) → 관리자 승인. 승인된 제휴사에도 정보 보관.
CREATE TABLE IF NOT EXISTS partner_applications (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,            -- E.164 (+82101234567 형식)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | removed
  note TEXT,
  submitted_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
ALTER TABLE partners ADD COLUMN company TEXT;
ALTER TABLE partners ADD COLUMN name TEXT;
ALTER TABLE partners ADD COLUMN phone TEXT;
