-- 2026-09-18: 연습(paper) 모드 제품에서 제거. 연습 엔진은 관리자·테스트(ALLOW_PAPER=on) 전용으로 남긴다.
-- 1) 모든 사용자를 실거래로 (관리자는 설정에서 다시 연습으로 돌아갈 수 있다)
UPDATE settings SET mode = 'live' WHERE mode = 'paper';
-- 2) 연습 모드로 진행 중이던 고수 따라하기는 멈추고 장부(copy_positions)를 지운다 — 연습 팔로우가 실계좌로 흘러가지 않게
DELETE FROM copy_positions WHERE follower_id IN (SELECT follower_id FROM copy_follows WHERE status = 'active' AND mode = 'paper');
UPDATE copy_follows SET status = 'stopped', stopped_at = strftime('%s','now') * 1000, stop_reason = 'mode_switch' WHERE status = 'active' AND mode = 'paper';
-- 3) API 키 없이 켜져 있던 AI 자동매매(= 연습 엔진으로 돌던 것)는 끈다. 사유는 사용자 화면에 보인다
UPDATE auto_settings SET enabled = 0, note = '연습 모드가 없어져 AI 자동매매를 껐어요. API 키를 연결한 뒤 다시 켜 주세요', updated_at = strftime('%s','now') * 1000
  WHERE enabled = 1 AND user_id NOT IN (SELECT user_id FROM api_keys);
