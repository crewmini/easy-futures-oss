-- 2026-09-18 고수 공개 숨김: 팔로워 수·거래 횟수·승률·30일 수익률·최근 마감 거래를 다른 사용자에게 숨길 수 있다 (docs/copy-trading.md §5)
ALTER TABLE copy_masters ADD COLUMN hide_json TEXT;   -- JSON { followers, trades, winRate, roi, recent }: true = 숨김. NULL = 전부 공개
