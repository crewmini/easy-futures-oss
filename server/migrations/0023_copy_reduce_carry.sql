-- 2026-09-22 카피 부분 정리 이월: 고수가 5% 줄였는데 팔로워 장부가 1~2계약이면 반올림 최소 1계약 규칙이 전량(또는 과다) 정리를 만들었다.
-- 정확한 비례 수량(장부 × 비율 + 이월)을 내림해 정수 계약만 정리하고, 1계약 미만 나머지는 다음 축소에 합산한다 (sizing.reduceContracts).
-- 전량 정리(행 삭제)·추가 진입 시 0 으로 되돌린다.
ALTER TABLE copy_positions ADD COLUMN reduce_carry REAL NOT NULL DEFAULT 0;
