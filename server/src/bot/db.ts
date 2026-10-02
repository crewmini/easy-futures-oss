// 저점 봇 저장소 (D1) — hlbot store/{watchlist,counts}.py 이식
import type { ChainEntry } from './strategy.js';

export interface CountRow extends ChainEntry { id: number; msgId: number | null; signalId: string | null; createdAt: number }
interface RawCount { id: number; seq: number; ts_ms: number; low: number; status: string; msg_id: number | null; signal_id: string | null; created_at: number }
const ACTIVE = ['proposed', 'confirmed'];

// ---- 감시목록 ----
export async function addWatch(db: D1Database, coin: string, tfs: string[]): Promise<void> {
  const now = Date.now();
  const uniq = [...new Set(tfs)];
  const cnt = await db.prepare('SELECT COUNT(*) n FROM bot_watchlist').first<{ n: number }>();
  if ((cnt?.n ?? 0) + uniq.length > WATCH_MAX) throw new Error(`감시 조합은 최대 ${WATCH_MAX}개까지예요`);
  await db.batch(uniq.map((tf) => db.prepare('INSERT OR IGNORE INTO bot_watchlist (coin, tf, created_at) VALUES (?, ?, ?)').bind(coin.toUpperCase(), tf, now)));
}
export async function removeWatch(db: D1Database, coin: string): Promise<number> {
  const r = await db.prepare('DELETE FROM bot_watchlist WHERE coin = ?').bind(coin.toUpperCase()).run();
  return r.meta.changes ?? 0;
}
export async function listWatches(db: D1Database): Promise<Record<string, string[]>> {
  const r = await db.prepare('SELECT coin, tf FROM bot_watchlist ORDER BY coin, tf').all<{ coin: string; tf: string }>();
  const out: Record<string, string[]> = {};
  for (const x of r.results ?? []) (out[x.coin] ??= []).push(x.tf);
  return out;
}

// ---- 카운트 ----
function toRow(r: RawCount): CountRow { return { id: r.id, seq: r.seq, tsMs: r.ts_ms, low: r.low, status: r.status as ChainEntry['status'], msgId: r.msg_id, signalId: r.signal_id ?? null, createdAt: r.created_at }; }
export async function addCount(db: D1Database, coin: string, tf: string, seq: number, tsMs: number, low: number, status: 'proposed' | 'confirmed' = 'proposed'): Promise<number> {
  const r = await db.prepare('INSERT INTO bot_counts (coin, tf, seq, ts_ms, low, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(coin, tf, seq, tsMs, low, status, Date.now()).run();
  return Number(r.meta.last_row_id);
}
export async function getCount(db: D1Database, id: number): Promise<(CountRow & { coin: string; tf: string }) | null> {
  const r = await db.prepare('SELECT * FROM bot_counts WHERE id = ?').bind(id).first<RawCount & { coin: string; tf: string }>();
  return r ? { ...toRow(r), coin: r.coin, tf: r.tf } : null;
}
export async function activeChain(db: D1Database, coin: string, tf: string): Promise<CountRow[]> {
  const r = await db.prepare("SELECT id, seq, ts_ms, low, status, msg_id, signal_id, created_at FROM bot_counts WHERE coin = ? AND tf = ? AND status IN ('proposed','confirmed') ORDER BY seq").bind(coin, tf).all<RawCount>();
  return (r.results ?? []).map(toRow);
}
export async function listActiveChains(db: D1Database): Promise<Record<string, CountRow[]>> {
  const r = await db.prepare("SELECT coin, tf, id, seq, ts_ms, low, status, msg_id, signal_id, created_at FROM bot_counts WHERE status IN ('proposed','confirmed') ORDER BY coin, tf, seq").all<RawCount & { coin: string; tf: string }>();
  const out: Record<string, CountRow[]> = {};
  for (const x of r.results ?? []) (out[`${x.coin}:${x.tf}`] ??= []).push(toRow(x));
  return out;
}
/** 활성 행만 상태 변경. confirmed 전이는 proposed 에서만 (✅ 재탭 중복 방지). 바뀐 행 수 */
export async function setCountStatus(db: D1Database, id: number, status: string): Promise<boolean> {
  const allowed = status === 'confirmed' ? ['proposed'] : ACTIVE;
  const r = await db.prepare(`UPDATE bot_counts SET status = ? WHERE id = ? AND status IN (${allowed.map(() => '?').join(',')})`).bind(status, id, ...allowed).run();
  return (r.meta.changes ?? 0) === 1;
}
export async function setCountMsgId(db: D1Database, id: number, msgId: number | null): Promise<void> {
  await db.prepare('UPDATE bot_counts SET msg_id = ? WHERE id = ?').bind(msgId, id).run();
}
export async function setCountSignal(db: D1Database, id: number, signalId: string): Promise<void> {
  await db.prepare('UPDATE bot_counts SET signal_id = ? WHERE id = ?').bind(signalId, id).run();
}
/** 유예가 지난 잠정 2·3번 후보 (자동 확정 후보). 체인 조건은 호출자가 본다 */
export async function listDueProposals(db: D1Database, before: number): Promise<(CountRow & { coin: string; tf: string })[]> {
  const r = await db.prepare("SELECT * FROM bot_counts WHERE status = 'proposed' AND seq >= 2 AND created_at <= ? ORDER BY coin, tf, seq").bind(before).all<RawCount & { coin: string; tf: string }>();
  return (r.results ?? []).map((x) => ({ ...toRow(x), coin: x.coin, tf: x.tf }));
}
/** seq 이상 활성 카운트 전부 취소. 취소된 수와 그중 확정(✅)이던 수 — 확정 저점이 지워질 때만 정리 신호를 낸다 */
export async function cancelFrom(db: D1Database, coin: string, tf: string, seq: number): Promise<{ n: number; confirmed: number }> {
  const c = await db.prepare("SELECT COUNT(*) n FROM bot_counts WHERE coin = ? AND tf = ? AND seq >= ? AND status = 'confirmed'").bind(coin, tf, seq).first<{ n: number }>();
  const r = await db.prepare("UPDATE bot_counts SET status = 'cancelled' WHERE coin = ? AND tf = ? AND seq >= ? AND status IN ('proposed','confirmed')").bind(coin, tf, seq).run();
  return { n: r.meta.changes ?? 0, confirmed: c?.n ?? 0 };
}
/** seq 이상 활성 카운트를 replaced 처리하고 해당 seq 를 confirmed 로 수동 지정 */
export async function setManual(db: D1Database, coin: string, tf: string, seq: number, tsMs: number, low: number): Promise<number> {
  await db.prepare("UPDATE bot_counts SET status = 'replaced' WHERE coin = ? AND tf = ? AND seq >= ? AND status IN ('proposed','confirmed')").bind(coin, tf, seq).run();
  return addCount(db, coin, tf, seq, tsMs, low, 'confirmed');
}

// ---- 평가 상태 ----
export async function getWatermark(db: D1Database, coin: string, tf: string): Promise<number> {
  const r = await db.prepare('SELECT last_eval_ms FROM bot_watch_state WHERE coin = ? AND tf = ?').bind(coin, tf).first<{ last_eval_ms: number }>();
  return r?.last_eval_ms ?? 0;
}
export async function setWatermark(db: D1Database, coin: string, tf: string, tsMs: number): Promise<void> {
  await db.prepare('INSERT INTO bot_watch_state (coin, tf, last_eval_ms) VALUES (?, ?, ?) ON CONFLICT(coin, tf) DO UPDATE SET last_eval_ms = excluded.last_eval_ms').bind(coin, tf, tsMs).run();
}
export async function getBreakMs(db: D1Database, coin: string, tf: string): Promise<number> {
  const r = await db.prepare('SELECT last_break_ms FROM bot_watch_state WHERE coin = ? AND tf = ?').bind(coin, tf).first<{ last_break_ms: number }>();
  return r?.last_break_ms ?? 0;
}
export async function setBreakMs(db: D1Database, coin: string, tf: string, tsMs: number): Promise<void> {
  await db.prepare('INSERT INTO bot_watch_state (coin, tf, last_break_ms) VALUES (?, ?, ?) ON CONFLICT(coin, tf) DO UPDATE SET last_break_ms = excluded.last_break_ms').bind(coin, tf, tsMs).run();
}
// ---- 이탈 자동 정리 대기 ----
export interface PendingBreak { coin: string; tf: string; seq: number; at: number; msgId: number | null }
export async function setPendingBreak(db: D1Database, coin: string, tf: string, seq: number, at: number, msgId: number | null): Promise<void> {
  await db.prepare('INSERT INTO bot_watch_state (coin, tf, break_seq, break_at, break_msg_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(coin, tf) DO UPDATE SET break_seq = excluded.break_seq, break_at = excluded.break_at, break_msg_id = excluded.break_msg_id').bind(coin, tf, seq, at, msgId).run();
}
export async function clearPendingBreak(db: D1Database, coin: string, tf: string): Promise<boolean> {
  const r = await db.prepare('UPDATE bot_watch_state SET break_seq = NULL, break_at = NULL, break_msg_id = NULL WHERE coin = ? AND tf = ? AND break_seq IS NOT NULL').bind(coin, tf).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function listDueBreaks(db: D1Database, before: number): Promise<PendingBreak[]> {
  const r = await db.prepare('SELECT coin, tf, break_seq, break_at, break_msg_id FROM bot_watch_state WHERE break_seq IS NOT NULL AND break_at <= ?').bind(before).all<{ coin: string; tf: string; break_seq: number; break_at: number; break_msg_id: number | null }>();
  return (r.results ?? []).map((x) => ({ coin: x.coin, tf: x.tf, seq: x.break_seq, at: x.break_at, msgId: x.break_msg_id }));
}
export async function markPolled(db: D1Database, coin: string, tf: string, error: string | null): Promise<void> {
  await db.prepare('INSERT INTO bot_watch_state (coin, tf, last_poll_at, last_error) VALUES (?, ?, ?, ?) ON CONFLICT(coin, tf) DO UPDATE SET last_poll_at = excluded.last_poll_at, last_error = excluded.last_error').bind(coin, tf, Date.now(), error).run();
}
export async function listWatchState(db: D1Database): Promise<{ coin: string; tf: string; lastEvalMs: number; lastPollAt: number | null; lastError: string | null }[]> {
  const r = await db.prepare('SELECT coin, tf, last_eval_ms, last_poll_at, last_error FROM bot_watch_state ORDER BY coin, tf').all<{ coin: string; tf: string; last_eval_ms: number; last_poll_at: number | null; last_error: string | null }>();
  return (r.results ?? []).map((x) => ({ coin: x.coin, tf: x.tf, lastEvalMs: x.last_eval_ms, lastPollAt: x.last_poll_at, lastError: x.last_error }));
}

// ---- 설정 ----
export interface BotSettings { relay: boolean; leverage: number; tpR: number; tfs: string[]; autoConfirm: boolean; graceMin: number }
export const DEFAULT_BOT_SETTINGS: BotSettings = { relay: true, leverage: 3, tpR: 1.5, tfs: [], autoConfirm: true, graceMin: 3 };
/** 이 체인의 2·3번·이탈을 자동 처리하는가: 설정 켜짐 + 신호 대상 TF + 1번이 ✅ 로 실제 진입 신호가 나간 체인 (📍 수동 지정 체인은 제외) */
export function autoEligible(s: BotSettings, tf: string, chain: CountRow[]): boolean {
  return s.autoConfirm && (s.tfs.length === 0 || s.tfs.includes(tf)) && chain.length > 0 && chain[0].seq === 1 && chain[0].status === 'confirmed' && !!chain[0].signalId;
}
export async function getBotSettings(db: D1Database): Promise<BotSettings> {
  const r = await db.prepare('SELECT key, value FROM bot_settings').all<{ key: string; value: string }>();
  const m = Object.fromEntries((r.results ?? []).map((x) => [x.key, x.value]));
  return {
    relay: m.relay !== 'off',
    leverage: Number(m.leverage) > 0 ? Math.round(Number(m.leverage)) : DEFAULT_BOT_SETTINGS.leverage,
    tpR: m.tpR !== undefined && Number.isFinite(Number(m.tpR)) && Number(m.tpR) >= 0 ? Number(m.tpR) : DEFAULT_BOT_SETTINGS.tpR,
    tfs: m.tfs ? m.tfs.split(' ').filter(Boolean) : [],
    autoConfirm: m.auto !== 'off',
    graceMin: Number(m.grace) >= 1 && Number(m.grace) <= 30 ? Math.round(Number(m.grace)) : DEFAULT_BOT_SETTINGS.graceMin,
  };
}
export async function setBotSetting(db: D1Database, key: 'relay' | 'leverage' | 'tpR' | 'tfs' | 'auto' | 'grace' | 'last_update_id', value: string, by = 'system'): Promise<void> {
  await db.prepare('INSERT INTO bot_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at').bind(key, value, by, Date.now()).run();
}
/** 텔레그램 update_id 중복 전달 차단: 마지막으로 처리한 id 보다 작거나 같으면 false */
export async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO bot_settings (key, value, updated_at) VALUES ('last_update_id', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(excluded.value AS INTEGER) > CAST(bot_settings.value AS INTEGER)").bind(String(updateId), Date.now()).run();
  return (r.meta.changes ?? 0) > 0;
}
export const WATCH_MAX = 20;
