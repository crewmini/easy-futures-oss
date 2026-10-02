-- 2026-09-07: 저점 카운팅 봇용 신호 필드 — 절대 손절/익절 가격, 본절, 불타기(add), 갱신(update)
ALTER TABLE auto_signals ADD COLUMN sl_price REAL;
ALTER TABLE auto_signals ADD COLUMN tp_price REAL;
ALTER TABLE auto_signals ADD COLUMN breakeven INTEGER NOT NULL DEFAULT 0;
