// 크론 보존 정리 (감사 A12·B20·B21): 오래된 기록을 매시간 한 번, 표마다 500건씩 지운다.
// 실거래 판단에 쓰는 행(활성 팔로우·포지션 장부·진행 중 저점 체인)은 건드리지 않는다. 자식 → 부모 순서로 지워 고아 참조를 만들지 않는다.
import type { Env } from './env.js';
import { log } from './log.js';

const DAY = 86_400_000;
export const RETENTION_DAYS = 180;      // 실행 기록·이벤트·신호 (주문 중복 확인은 95일까지만 본다)
export const BOT_RETENTION_DAYS = 90;   // 끝난 저점 체인 (취소·교체·거부). 진행 중(proposed/confirmed)은 절대 안 지움
export const RETENTION_BATCH = 500;

async function purge(db: D1Database, table: string, where: string, ...binds: unknown[]): Promise<number> {
  // D1(SQLite) 은 DELETE ... LIMIT 을 보장하지 않으므로 rowid 부분 선택으로 500건씩
  const r = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${RETENTION_BATCH})`).bind(...binds).run();
  return r.meta.changes ?? 0;
}

/** 보존 기간이 지난 행 삭제. 표별 삭제 수를 돌려준다 (로그·테스트용) */
export async function runRetention(env: Pick<Env, 'DB'>, now = Date.now()): Promise<Record<string, number>> {
  const db = env.DB;
  const old = now - RETENTION_DAYS * DAY;
  const botOld = now - BOT_RETENTION_DAYS * DAY;
  const dayAgo = now - DAY;
  const counts: Record<string, number> = {};
  // 실행 기록 먼저, 부모(신호·이벤트)는 남은 자식이 없을 때만 (같은 배치에서 자식이 500건을 넘겨 남아 있으면 다음 시간에)
  counts.auto_executions = await purge(db, 'auto_executions', 'created_at < ?', old);
  counts.auto_signals = await purge(db, 'auto_signals', 'created_at < ? AND NOT EXISTS (SELECT 1 FROM auto_executions e WHERE e.signal_id = auto_signals.id)', old);
  counts.copy_executions = await purge(db, 'copy_executions', 'created_at < ?', old);
  counts.copy_events = await purge(db, 'copy_events', 'created_at < ? AND NOT EXISTS (SELECT 1 FROM copy_executions x WHERE x.event_id = copy_events.id)', old);
  // 저점 봇: 끝난 체인만. bot_watch_state.break_seq 는 진행 중 체인의 seq 라 여기 걸리지 않는다
  counts.bot_counts = await purge(db, 'bot_counts', "created_at < ? AND status IN ('cancelled','replaced','vetoed')", botOld);
  // 로그인 실패 카운터: 잠금이 풀린 지 하루, 또는 마지막 실패로부터 하루 (updated_at 이 없는 옛 행은 바로)
  counts.login_attempts = await purge(db, 'login_attempts', 'COALESCE(locked_until, updated_at, 0) < ?', dayAgo);
  counts.signup_attempts = await purge(db, 'signup_attempts', 'window_start < ?', dayAgo);
  counts.login_ip_attempts = await purge(db, 'login_ip_attempts', 'window_start < ?', dayAgo);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) log.info('retention purged', counts);
  return counts;
}
