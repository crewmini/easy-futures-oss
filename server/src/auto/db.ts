// 자동매매 저장소 헬퍼 (D1)
import type { AutoExecution, AutoSettings, AutoSignal, AutoStatus, Direction, Mode, Symbol } from '@easy-futures/shared';
import { AUTO_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import type { Env } from '../env.js';
import { invalidateUser } from '../db.js';
import { HttpError } from '../errors.js';

interface AutoSettingsRow { user_id: number; enabled: number; pct: number; max_leverage: number; default_sl_roi: number; agreed_at: number | null; applied_at: number | null; decided_at: number | null; decided_by: string | null; note: string | null; auto_terms_version?: string | null }
interface SignalRow { id: string; source: string; symbol: string; action: string; direction: string | null; leverage: number | null; sl_roi: number | null; tp_roi: number | null; sl_price: number | null; tp_price: number | null; breakeven: number | null; note: string | null; created_at: number; processed_at: number | null; follower_count: number | null; ok_count: number | null; fail_count: number | null }
interface ExecRow { id: number; signal_id: string; user_id: number; mode: string; status: string; detail: string | null; order_id: string | null; created_at: number; symbol?: string; action?: string; direction?: string | null; leverage?: number | null; note?: string | null }

export const DEFAULT_AUTO: AutoSettings = { enabled: false, pct: 10, maxLeverage: 5, defaultSlRoi: 20 };

export function rowToSettings(r: AutoSettingsRow | null): AutoSettings {
  return r ? { enabled: !!r.enabled, pct: r.pct, maxLeverage: r.max_leverage, defaultSlRoi: r.default_sl_roi } : { ...DEFAULT_AUTO };
}
export async function getAutoRow(db: D1Database, userId: number): Promise<AutoSettingsRow | null> {
  return db.prepare('SELECT * FROM auto_settings WHERE user_id = ?').bind(userId).first<AutoSettingsRow>();
}
export async function getAutoStatus(db: D1Database, userId: number): Promise<AutoStatus> {
  const r = await db.prepare('SELECT auto_status FROM users WHERE id = ?').bind(userId).first<{ auto_status: string }>();
  return (r?.auto_status ?? 'none') as AutoStatus;
}
export async function applyAuto(db: D1Database, userId: number, s: AutoSettings, autoTermsVersion: string | null = null): Promise<void> {
  const now = Date.now();
  const cur = await getAutoStatus(db, userId);
  if (cur === 'suspended') throw new HttpError(409, 'AI 자동매매가 중지된 상태예요. 담당자에게 문의해 주세요', 'SUSPENDED'); // 감사 M2: 중지 사유를 지우며 다시 대기열에 올라오지 않게
  await db.batch([
    db.prepare(`INSERT INTO auto_settings (user_id, enabled, pct, max_leverage, default_sl_roi, agreed_at, applied_at, updated_at, auto_terms_version) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET pct = excluded.pct, max_leverage = excluded.max_leverage, default_sl_roi = excluded.default_sl_roi, agreed_at = excluded.agreed_at, applied_at = excluded.applied_at, updated_at = excluded.updated_at, auto_terms_version = excluded.auto_terms_version, note = NULL`)
      .bind(userId, s.pct, s.maxLeverage, s.defaultSlRoi, now, now, now, autoTermsVersion),
    db.prepare("UPDATE users SET auto_status = 'pending' WHERE id = ? AND auto_status IN ('none','rejected')").bind(userId),
    // 이미 승인된 사용자의 재신청 = 특약 재동의·설정 갱신 (상태 유지)
  ]);
  invalidateUser(userId);
}
export async function saveAutoSettings(db: D1Database, userId: number, s: AutoSettings): Promise<void> {
  await db.prepare(`INSERT INTO auto_settings (user_id, enabled, pct, max_leverage, default_sl_roi, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, pct = excluded.pct, max_leverage = excluded.max_leverage, default_sl_roi = excluded.default_sl_roi, updated_at = excluded.updated_at`)
    .bind(userId, s.enabled ? 1 : 0, s.pct, s.maxLeverage, s.defaultSlRoi, Date.now()).run();
}
/** 관리자 결정. 승인은 신청(pending)·중지(suspended) 상태에서만 — 신청 없이 승인하면 특약 동의 기록이 없다 (감사 M1). 바뀐 행이 없으면 false */
export async function setAutoStatus(db: D1Database, userId: number, status: AutoStatus, by: string, note: string | null): Promise<boolean> {
  if (status === 'approved') {
    const r = await db.prepare("UPDATE users SET auto_status = 'approved' WHERE id = ? AND auto_status IN ('pending','suspended') AND deleted_at IS NULL").bind(userId).run();
    if (!(r.meta.changes ?? 0)) return false;
    await db.prepare('UPDATE auto_settings SET decided_at = ?, decided_by = ?, note = ? WHERE user_id = ?').bind(Date.now(), by, note, userId).run();
    invalidateUser(userId);
    return true;
  }
  const stmts = [
    db.prepare('UPDATE users SET auto_status = ? WHERE id = ? AND deleted_at IS NULL').bind(status, userId),
    db.prepare('UPDATE auto_settings SET decided_at = ?, decided_by = ?, note = ? WHERE user_id = ?').bind(Date.now(), by, note, userId),
  ];
  stmts.push(db.prepare('UPDATE auto_settings SET enabled = 0 WHERE user_id = ?').bind(userId));
  await db.batch(stmts);
  invalidateUser(userId);
  return true;
}
/** 특약 버전이 바뀌면 다시 동의해야 실행된다 — 사용자 화면 표시용 */
export async function autoTermsOutdated(row: { auto_terms_version?: string | null } | null): Promise<boolean> {
  return !!row && row.auto_terms_version !== AUTO_TERMS_VERSION;
}
export async function listAutoUsers(db: D1Database, status: AutoStatus): Promise<{ userId: number; loginId: string; uid: string | null; enabled: boolean; pct: number; maxLeverage: number; appliedAt: number | null; note: string | null }[]> {
  const r = await db.prepare('SELECT u.id, u.login_id, u.uid, a.enabled, a.pct, a.max_leverage, a.applied_at, a.note FROM users u LEFT JOIN auto_settings a ON a.user_id = u.id WHERE u.auto_status = ? AND u.deleted_at IS NULL ORDER BY a.applied_at ASC').bind(status).all<{ id: number; login_id: string; uid: string | null; enabled: number | null; pct: number | null; max_leverage: number | null; applied_at: number | null; note: string | null }>();
  return (r.results ?? []).map((x) => ({ userId: x.id, loginId: x.login_id, uid: x.uid, enabled: !!x.enabled, pct: x.pct ?? DEFAULT_AUTO.pct, maxLeverage: x.max_leverage ?? DEFAULT_AUTO.maxLeverage, appliedAt: x.applied_at, note: x.note }));
}
/** 신호를 실행할 대상: 승인 + 켬 + 탈퇴 아님 + 신분증 승인 + 최신 약관·특약 동의 + 임시 비밀번호 아님 (감사 H5) */
export async function listFollowers(db: D1Database): Promise<{ userId: number; settings: AutoSettings }[]> {
  const r = await db.prepare("SELECT u.id, a.enabled, a.pct, a.max_leverage, a.default_sl_roi FROM users u JOIN auto_settings a ON a.user_id = u.id WHERE u.auto_status = 'approved' AND a.enabled = 1 AND u.deleted_at IS NULL AND u.kyc_status = 'approved' AND u.terms_version = ? AND COALESCE(u.must_change_pw, 0) = 0 AND a.auto_terms_version = ?").bind(TERMS_VERSION, AUTO_TERMS_VERSION).all<{ id: number; enabled: number; pct: number; max_leverage: number; default_sl_roi: number }>();
  return (r.results ?? []).map((x) => ({ userId: x.id, settings: { enabled: true, pct: x.pct, maxLeverage: x.max_leverage, defaultSlRoi: x.default_sl_roi } }));
}

// ---- 신호 ----
function toSignal(r: SignalRow): AutoSignal {
  return { id: r.id, source: r.source as 'bot' | 'admin', symbol: r.symbol as Symbol, action: r.action as AutoSignal['action'], direction: (r.direction as Direction | null) ?? null, leverage: r.leverage, slRoi: r.sl_roi, tpRoi: r.tp_roi, slPrice: r.sl_price ?? null, tpPrice: r.tp_price ?? null, breakeven: !!r.breakeven, note: r.note, createdAt: r.created_at, processedAt: r.processed_at, followerCount: r.follower_count, okCount: r.ok_count, failCount: r.fail_count };
}
/** 저장. 이미 있는 id 면 false (중복 실행 방지) */
export async function insertSignal(db: D1Database, s: AutoSignal): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO auto_signals (id, source, symbol, action, direction, leverage, sl_roi, tp_roi, sl_price, tp_price, breakeven, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(s.id, s.source, s.symbol, s.action, s.direction, s.leverage, s.slRoi, s.tpRoi, s.slPrice, s.tpPrice, s.breakeven ? 1 : 0, s.note, s.createdAt).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function getSignal(db: D1Database, id: string): Promise<AutoSignal | null> {
  const r = await db.prepare('SELECT * FROM auto_signals WHERE id = ?').bind(id).first<SignalRow>();
  return r ? toSignal(r) : null;
}
export async function listSignals(db: D1Database, limit = 20): Promise<AutoSignal[]> {
  const r = await db.prepare('SELECT * FROM auto_signals ORDER BY created_at DESC LIMIT ?').bind(limit).all<SignalRow>();
  return (r.results ?? []).map(toSignal);
}
export async function finishSignal(db: D1Database, id: string, followers: number, ok: number, fail: number, skipped = 0): Promise<void> {
  await db.prepare('UPDATE auto_signals SET processed_at = ?, follower_count = ?, ok_count = ?, fail_count = ?, skipped_count = ? WHERE id = ?').bind(Date.now(), followers, ok, fail, skipped, id).run();
}
/** 같은 신호·같은 사용자는 한 번만 기록 (샤드 장애 뒤 재기록이 실제 결과를 덮지 않게). 기록됐으면 true */
export async function insertExecution(db: D1Database, signalId: string, userId: number, mode: Mode, status: 'ok' | 'skipped' | 'failed', detail: string | null, orderId: string | null): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO auto_executions (signal_id, user_id, mode, status, detail, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(signalId, userId, mode, status, detail, orderId, Date.now()).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 이 신호를 이미 실행(기록)한 사용자 — 재실행 시 제외 */
export async function executedUserIds(db: D1Database, signalId: string): Promise<Set<number>> {
  const r = await db.prepare('SELECT user_id FROM auto_executions WHERE signal_id = ?').bind(signalId).all<{ user_id: number }>();
  return new Set((r.results ?? []).map((x) => x.user_id));
}
/** 관리자용: 신호 1건의 사용자별 실행 결과 */
export async function listSignalExecutions(db: D1Database, signalId: string): Promise<{ userId: number; loginId: string; mode: Mode; status: AutoExecution['status']; detail: string | null; orderId: string | null; createdAt: number }[]> {
  const r = await db.prepare('SELECT e.user_id, u.login_id, e.mode, e.status, e.detail, e.order_id, e.created_at FROM auto_executions e JOIN users u ON u.id = e.user_id WHERE e.signal_id = ? ORDER BY e.status, e.created_at').bind(signalId).all<{ user_id: number; login_id: string; mode: string; status: string; detail: string | null; order_id: string | null; created_at: number }>();
  return (r.results ?? []).map((x) => ({ userId: x.user_id, loginId: x.login_id, mode: x.mode as Mode, status: x.status as AutoExecution['status'], detail: x.detail, orderId: x.order_id, createdAt: x.created_at }));
}
/** 자동매매 끄기 (키 삭제·연습 전환·신분증 거절·키 거절 시). 사유는 사용자 화면에 보인다. 실제로 꺼졌으면 true */
export async function disableAuto(db: D1Database, userId: number, note: string): Promise<boolean> {
  const r = await db.prepare('UPDATE auto_settings SET enabled = 0, note = ?, updated_at = ? WHERE user_id = ? AND enabled = 1').bind(note, Date.now(), userId).run();
  invalidateUser(userId);
  return (r.meta.changes ?? 0) > 0;
}
/** 이 사용자의 자동매매 진입 주문 id → 신호 id (거래 내역 출처 판정용) */
export async function loadAutoTags(db: D1Database, userId: number): Promise<Map<string, { signalId: string }>> {
  const r = await db.prepare("SELECT order_id, signal_id FROM auto_executions WHERE user_id = ? AND order_id IS NOT NULL AND status = 'ok' AND created_at >= ?").bind(userId, Date.now() - 95 * 86_400_000).all<{ order_id: string; signal_id: string }>();
  return new Map((r.results ?? []).map((x) => [x.order_id, { signalId: x.signal_id }]));
}
export async function listMyExecutions(db: D1Database, userId: number, limit = 30): Promise<AutoExecution[]> {
  const r = await db.prepare('SELECT e.*, s.symbol, s.action, s.direction, s.leverage, s.note FROM auto_executions e JOIN auto_signals s ON s.id = e.signal_id WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT ?').bind(userId, limit).all<ExecRow>();
  return (r.results ?? []).map((x) => ({ id: x.id, signalId: x.signal_id, mode: x.mode as Mode, status: x.status as AutoExecution['status'], detail: x.detail, createdAt: x.created_at, orderId: x.order_id ?? null, signal: { symbol: x.symbol as Symbol, action: x.action as AutoSignal['action'], direction: (x.direction as Direction | null) ?? null, leverage: x.leverage ?? null, note: x.note ?? null } }));
}
export type { Env };
