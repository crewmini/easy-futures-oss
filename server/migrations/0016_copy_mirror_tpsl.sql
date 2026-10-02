-- 카피: 마스터의 손절·익절·배율 변경도 실시간 복제 (2026-09-18 사용자 요구)
ALTER TABLE copy_master_state ADD COLUMN sl_price REAL;
ALTER TABLE copy_master_state ADD COLUMN tp_price REAL;
ALTER TABLE copy_events ADD COLUMN sl_price REAL;
ALTER TABLE copy_events ADD COLUMN tp_price REAL;
ALTER TABLE copy_positions ADD COLUMN sl_price REAL;
ALTER TABLE copy_positions ADD COLUMN tp_price REAL;
