-- 2·3번 자동 확정 + 이탈 자동 정리 (2026-09-15)
ALTER TABLE bot_counts ADD COLUMN signal_id TEXT;            -- 이 카운트로 실제 나간 AI 자동매매 신호 id (1번이 있어야 2·3 자동 확정 대상)
ALTER TABLE bot_watch_state ADD COLUMN break_seq INTEGER;    -- 자동 정리 대기 중인 이탈 seq (NULL = 없음)
ALTER TABLE bot_watch_state ADD COLUMN break_at INTEGER;     -- 이탈 알림 시각 (유예 기준)
ALTER TABLE bot_watch_state ADD COLUMN break_msg_id INTEGER; -- 이탈 알림 텔레그램 메시지 id
