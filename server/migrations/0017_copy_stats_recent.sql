-- 카피: 고수 최근 마감 거래 10건을 통계와 함께 D1 에 캐시 (프로필 갱신을 updated_at 5분 게이트로 — 아이솔레이트 Map 캐시 제거)
ALTER TABLE copy_master_stats ADD COLUMN recent_json TEXT;
