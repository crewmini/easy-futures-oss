-- 2026-09-07: 사용자 요청으로 기본 한도 상향 (배율 100배, 1회 금액 사실상 무제한)
UPDATE settings SET max_leverage = 100 WHERE max_leverage = 10;
UPDATE settings SET max_amount_usdt = 100000 WHERE max_amount_usdt = 500;
