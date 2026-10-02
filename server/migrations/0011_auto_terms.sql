-- 2026-09-08: 자동매매 특약 동의 버전 기록 (법적 증빙: 어떤 문구에 언제 동의했는지)
ALTER TABLE auto_settings ADD COLUMN auto_terms_version TEXT;
