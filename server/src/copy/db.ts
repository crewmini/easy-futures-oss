// 카피 트레이딩 저장소 (D1 0015) — docs/copy-trading.md §4
import type { CopyCloseReason, CopyEvent, CopyEventKind, CopyExecution, CopyFollowSettings, CopyFollowStatus, CopyLeftover, CopyLeftoverReason, CopyMasterHide, CopyMasterStatus, CopyStopReason, Direction, Mode, Symbol } from '@easy-futures/shared';
import { COPY_TERMS_VERSION, DEFAULT_COPY_MASTER_HIDE, MASTER_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import { invalidateUser } from '../db.js';
import { HttpError } from '../errors.js';

// ---------- 행 타입 ----------
export interface MasterRow { userId: number; nickname: string; intro: string | null; status: CopyMasterStatus; termsVersion: string | null; appliedAt: number; decidedAt: number | null; decidedBy: string | null; note: string | null; createdAt: number; paused: boolean; hide: CopyMasterHide }   // paused = 운영자가 이 고수의 새 진입을 멈춤 (D1 0020), hide = 고수가 공개 카드에서 숨긴 항목 (D1 0021)
export interface FollowRow {
  id: number; followerId: number; masterId: number; status: CopyFollowStatus; mode: Mode; settings: CopyFollowSettings; copyAmountNow: number;
  termsVersion: string; agreedAt: number; startedAt: number; stoppedAt: number | null; stopReason: CopyStopReason | null; realizedPnl: number;
  userTermsVersion?: string | null;   // listActiveFollowers 만 채움 (이용약관 최신 여부 — 새 진입 게이트)
}
export interface MasterStateRow { symbol: Symbol; direction: Direction | null; contracts: number; entryPrice: number | null; leverage: number | null; equity: number | null; slPrice?: number | null; tpPrice?: number | null; updatedAt: number }
export interface MasterMeta { seq: number; wsOk: boolean; lastPollAt: number | null; lastError: string | null }
export interface CopyPositionRow { followerId: number; masterId: number; symbol: Symbol; direction: Direction; contracts: number; entryPrice: number; leverage: number; slPrice?: number | null; tpPrice?: number | null; openedAt: number; updatedAt: number }
export interface MasterRecentTrade { closedAt: number; symbol: Symbol; direction: Direction; roiPct: number }
export type StatsMetric = 'roi' | 'winRate' | 'recent';
export interface StatsSince { roi: number; winRate: number; recent: number }   // 초기화 기준 시각 (0 = 없음)
export interface MasterStats { days30Pnl: number; days30Roi: number; winRate: number; trades: number; recent: MasterRecentTrade[]; updatedAt: number; since?: StatsSince }

interface RawMaster { user_id: number; nickname: string; intro: string | null; status: string; terms_version: string | null; applied_at: number; decided_at: number | null; decided_by: string | null; note: string | null; created_at: number; paused?: number | null; hide_json?: string | null }
interface RawFollow { id: number; follower_id: number; master_id: number; status: string; mode: string; copy_amount: number; copy_amount_now: number; loss_limit_pct: number; max_leverage: number; sl_roi: number; terms_version: string; agreed_at: number; started_at: number; stopped_at: number | null; stop_reason: string | null; realized_pnl: number }
interface RawEvent { id: string; master_id: number; seq: number; symbol: string; kind: string; direction: string; before_contracts: number; after_contracts: number; price: number; leverage: number; master_equity: number; sl_price?: number | null; tp_price?: number | null; created_at: number; processed_at: number | null; follower_count: number | null; ok_count: number | null; fail_count: number | null; skipped_count: number | null; close_reason?: string | null }
interface RawExec { event_id: string; follower_id: number; mode: string; status: string; detail: string | null; order_id: string | null; contracts: number; created_at: number; fill_price?: number | null; symbol?: string; kind?: string; direction?: string; price?: number; close_reason?: string | null }
interface RawLeftover { id: number; follow_id: number; follower_id: number; master_id: number; symbol: string; direction: string; contracts: number; entry_price: number; leverage: number; sl_price: number | null; tp_price: number | null; reason: string; created_at: number; acked_at: number | null }
interface RawPos { follower_id: number; master_id: number; symbol: string; direction: string; contracts: number; entry_price: number; leverage: number; sl_price?: number | null; tp_price?: number | null; opened_at: number; updated_at: number }

/** hide_json → CopyMasterHide. NULL·깨진 JSON·모르는 키는 기본값(전부 공개)으로 */
export function parseMasterHide(json: string | null | undefined): CopyMasterHide {
  const out = { ...DEFAULT_COPY_MASTER_HIDE };
  if (!json) return out;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (o && typeof o === 'object') for (const k of Object.keys(out) as (keyof CopyMasterHide)[]) out[k] = o[k] === true;
  } catch { /* 깨진 값은 전부 공개로 */ }
  return out;
}
const toMaster = (r: RawMaster): MasterRow => ({ userId: r.user_id, nickname: r.nickname, intro: r.intro, status: r.status as CopyMasterStatus, termsVersion: r.terms_version, appliedAt: r.applied_at, decidedAt: r.decided_at, decidedBy: r.decided_by, note: r.note, createdAt: r.created_at, paused: !!r.paused, hide: parseMasterHide(r.hide_json) });
const toFollow = (r: RawFollow): FollowRow => ({
  id: r.id, followerId: r.follower_id, masterId: r.master_id, status: r.status as CopyFollowStatus, mode: r.mode as Mode,
  settings: { copyAmount: r.copy_amount, lossLimitPct: r.loss_limit_pct, maxLeverage: r.max_leverage, slRoi: r.sl_roi },
  copyAmountNow: r.copy_amount_now, termsVersion: r.terms_version, agreedAt: r.agreed_at, startedAt: r.started_at, stoppedAt: r.stopped_at, stopReason: (r.stop_reason as CopyStopReason | null) ?? null, realizedPnl: r.realized_pnl,
});
export const toEvent = (r: RawEvent): CopyEvent => ({
  id: r.id, masterId: r.master_id, seq: r.seq, symbol: r.symbol as Symbol, kind: r.kind as CopyEventKind, direction: r.direction as Direction,
  beforeContracts: r.before_contracts, afterContracts: r.after_contracts, price: r.price, leverage: r.leverage, masterEquity: r.master_equity,
  slPrice: r.sl_price ?? null, tpPrice: r.tp_price ?? null,
  createdAt: r.created_at, processedAt: r.processed_at, followerCount: r.follower_count, okCount: r.ok_count, failCount: r.fail_count, skippedCount: r.skipped_count,
  closeReason: toCloseReason(r.close_reason),
});
const toCloseReason = (v: string | null | undefined): CopyCloseReason | null => (v === 'liquidation' || v === 'adl' || v === 'normal' ? v : null);
/** 고수 정리 사유 → 팔로워 실행 내역 앞머리 (강제정리·ADL 만 표시, 직접 정리는 표시 없음) */
export const closeReasonLabel = (reason: CopyCloseReason | null | undefined): string | null => (reason === 'liquidation' ? '고수 강제정리로 정리' : reason === 'adl' ? '고수 자동감축(ADL)으로 정리' : null);
/**
 * 슬리피지 %: (팔로워 체결가 − 이벤트 가격) / 이벤트 가격 × 100 을 "팔로워에게 불리하면 양수" 로 부호를 맞춘다.
 * 진입(open/add) 롱은 비싸게 살수록, 숏은 싸게 팔수록 불리. 정리(close/reduce) 는 반대. 값이 없으면 null
 */
export function slippagePctOf(kind: CopyEventKind, direction: Direction, eventPrice: number | null | undefined, fillPrice: number | null | undefined): number | null {
  if (!(eventPrice != null && eventPrice > 0) || !(fillPrice != null && fillPrice > 0)) return null;
  if (kind === 'tpsl' || kind === 'leverage') return null;
  const isEntry = kind === 'open' || kind === 'add';
  const sign = isEntry === (direction === 'long') ? 1 : -1;
  return Math.round(sign * ((fillPrice - eventPrice) / eventPrice) * 100 * 10000) / 10000;
}
const toExec = (r: RawExec): CopyExecution => {
  const kind = r.kind as CopyEventKind | undefined;
  const closeReason = toCloseReason(r.close_reason);
  const label = kind === 'close' ? closeReasonLabel(closeReason) : null;
  return {
    eventId: r.event_id, followerId: r.follower_id, mode: r.mode as Mode, status: r.status as CopyExecution['status'], detail: label && r.status === 'ok' ? `${label} · ${r.detail ?? ''}` : r.detail, orderId: r.order_id, contracts: r.contracts, createdAt: r.created_at,
    fillPrice: r.fill_price ?? null,
    slippagePct: r.symbol && kind ? slippagePctOf(kind, r.direction as Direction, r.price, r.fill_price) : null,
    ...(r.symbol ? { event: { symbol: r.symbol as Symbol, kind: kind as CopyEventKind, direction: r.direction as Direction, price: r.price ?? 0, closeReason } } : {}),
  };
};
const toLeftover = (r: RawLeftover): CopyLeftover & { id: number; followId: number; followerId: number; masterId: number; slPrice: number | null; tpPrice: number | null; ackedAt: number | null } => ({
  id: r.id, followId: r.follow_id, followerId: r.follower_id, masterId: r.master_id, symbol: r.symbol as Symbol, direction: r.direction as Direction, contracts: r.contracts, entryPrice: r.entry_price, leverage: r.leverage,
  slPrice: r.sl_price ?? null, tpPrice: r.tp_price ?? null, reason: r.reason as CopyLeftoverReason, createdAt: r.created_at, ackedAt: r.acked_at,
});
const toPos = (r: RawPos): CopyPositionRow => ({ followerId: r.follower_id, masterId: r.master_id, symbol: r.symbol as Symbol, direction: r.direction as Direction, contracts: r.contracts, entryPrice: r.entry_price, leverage: r.leverage, slPrice: r.sl_price ?? null, tpPrice: r.tp_price ?? null, openedAt: r.opened_at, updatedAt: r.updated_at });

// ---------- 마스터 ----------
export async function getMaster(db: D1Database, userId: number): Promise<MasterRow | null> {
  const r = await db.prepare('SELECT * FROM copy_masters WHERE user_id = ?').bind(userId).first<RawMaster>();
  return r ? toMaster(r) : null;
}
export async function nicknameTaken(db: D1Database, nickname: string, exceptUserId?: number): Promise<boolean> {
  const r = await db.prepare('SELECT user_id FROM copy_masters WHERE nickname = ? COLLATE NOCASE').bind(nickname).first<{ user_id: number }>();
  return !!r && r.user_id !== exceptUserId;
}
/** 신청 (없으면 생성, rejected 였으면 재신청). approved/suspended/pending 이면 409 */
export async function applyMaster(db: D1Database, userId: number, nickname: string, intro: string, termsVersion: string): Promise<void> {
  const cur = await getMaster(db, userId);
  if (cur && cur.status !== 'rejected') throw new HttpError(409, cur.status === 'pending' ? '이미 신청해서 승인을 기다리는 중이에요' : cur.status === 'approved' ? '이미 고수로 등록돼 있어요' : '중지된 고수 계정이에요. 담당자에게 문의하세요', 'COPY_MASTER_STATE');
  if (await nicknameTaken(db, nickname, userId)) throw new HttpError(409, '이미 쓰는 이름이에요. 다른 이름을 골라 주세요', 'NICKNAME_TAKEN');
  const now = Date.now();
  try {
    await db.prepare(`INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, intro = excluded.intro, status = 'pending', terms_version = excluded.terms_version, applied_at = excluded.applied_at, decided_at = NULL, decided_by = NULL, note = NULL`)
      .bind(userId, nickname, intro, termsVersion, now, now).run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new HttpError(409, '이미 쓰는 이름이에요. 다른 이름을 골라 주세요', 'NICKNAME_TAKEN');   // 확인과 삽입 사이의 경합
    throw e;
  }
}
export async function updateMasterIntro(db: D1Database, userId: number, intro: string): Promise<boolean> {
  const r = await db.prepare('UPDATE copy_masters SET intro = ? WHERE user_id = ?').bind(intro, userId).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 공개 숨김 저장 (D1 0021). 고수 행이 없으면 false */
export async function updateMasterHide(db: D1Database, userId: number, hide: CopyMasterHide): Promise<boolean> {
  const r = await db.prepare('UPDATE copy_masters SET hide_json = ? WHERE user_id = ?').bind(JSON.stringify(hide), userId).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 상태 전이. approve 는 pending/suspended 에서만, suspend/reject 는 어디서든(reject 는 pending 에서만). 바뀌었으면 true */
export async function setMasterStatus(db: D1Database, userId: number, status: Exclude<CopyMasterStatus, 'none'>, by: string, note: string | null): Promise<boolean> {
  const from = status === 'approved' ? ['pending', 'suspended'] : status === 'rejected' ? ['pending'] : ['pending', 'approved', 'suspended'];
  const r = await db.prepare(`UPDATE copy_masters SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE user_id = ? AND status IN (${from.map(() => '?').join(',')})`).bind(status, Date.now(), by, note, userId, ...from).run();
  invalidateUser(userId);
  return (r.meta.changes ?? 0) > 0;
}
export async function listMasters(db: D1Database, status: CopyMasterStatus): Promise<MasterRow[]> {
  const r = await db.prepare('SELECT * FROM copy_masters WHERE status = ? ORDER BY applied_at ASC').bind(status).all<RawMaster>();
  return (r.results ?? []).map(toMaster);
}
export async function listApprovedMasterIds(db: D1Database): Promise<number[]> {
  const r = await db.prepare("SELECT m.user_id FROM copy_masters m JOIN users u ON u.id = m.user_id WHERE m.status = 'approved' AND u.deleted_at IS NULL").all<{ user_id: number }>();
  return (r.results ?? []).map((x) => x.user_id);
}
export const masterTermsOutdated = (m: MasterRow | null): boolean => !!m && m.status !== 'none' && m.termsVersion !== MASTER_TERMS_VERSION;

// ---------- 킬 스위치 (D1 0020): 새 진입(open/add)만 멈춘다. 정리·손절·배율·손실 한도는 계속, 감시도 계속, 팔로우도 active 그대로 ----------
export const PAUSED_GLOBAL_KEY = 'paused_global';
export async function getCopyFlag(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM copy_flags WHERE key = ?').bind(key).first<{ value: string | null }>();
  return r?.value ?? null;
}
export async function setCopyFlag(db: D1Database, key: string, value: string | null, by: string): Promise<void> {
  await db.prepare('INSERT INTO copy_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by').bind(key, value, Date.now(), by).run();
}
export const isPausedGlobal = async (db: D1Database): Promise<boolean> => (await getCopyFlag(db, PAUSED_GLOBAL_KEY)) === '1';
export async function setMasterPaused(db: D1Database, userId: number, paused: boolean): Promise<boolean> {
  const r = await db.prepare('UPDATE copy_masters SET paused = ? WHERE user_id = ?').bind(paused ? 1 : 0, userId).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 이 고수의 새 진입이 멈춰 있는가 (전체 킬 스위치 또는 고수별) */
export async function entryPaused(db: D1Database, masterId: number): Promise<{ paused: boolean; global: boolean; master: boolean }> {
  const [g, m] = await Promise.all([isPausedGlobal(db), db.prepare('SELECT paused FROM copy_masters WHERE user_id = ?').bind(masterId).first<{ paused: number | null }>()]);
  const master = !!m?.paused;
  return { paused: g || master, global: g, master };
}

// ---------- 팔로우 ----------
export async function getActiveFollow(db: D1Database, followerId: number): Promise<FollowRow | null> {
  const r = await db.prepare("SELECT * FROM copy_follows WHERE follower_id = ? AND status = 'active'").bind(followerId).first<RawFollow>();
  return r ? toFollow(r) : null;
}
export async function getLatestFollow(db: D1Database, followerId: number): Promise<FollowRow | null> {
  const r = await db.prepare('SELECT * FROM copy_follows WHERE follower_id = ? ORDER BY started_at DESC LIMIT 1').bind(followerId).first<RawFollow>();
  return r ? toFollow(r) : null;
}
export async function getFollow(db: D1Database, id: number): Promise<FollowRow | null> {
  const r = await db.prepare('SELECT * FROM copy_follows WHERE id = ?').bind(id).first<RawFollow>();
  return r ? toFollow(r) : null;
}
/** 팔로우 시작. 이미 active 면 부분 UNIQUE 인덱스가 막는다 → 409 */
export async function createFollow(db: D1Database, followerId: number, masterId: number, mode: Mode, s: CopyFollowSettings, termsVersion: string): Promise<number> {
  const now = Date.now();
  try {
    const r = await db.prepare(`INSERT INTO copy_follows (follower_id, master_id, status, mode, copy_amount, copy_amount_now, loss_limit_pct, max_leverage, sl_roi, terms_version, agreed_at, started_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(followerId, masterId, mode, s.copyAmount, s.copyAmount, s.lossLimitPct, s.maxLeverage, s.slRoi, termsVersion, now, now).run();
    invalidateUser(followerId);
    return Number(r.meta.last_row_id);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new HttpError(409, '이미 따라가는 고수가 있어요. 먼저 멈춘 뒤 다시 골라 주세요', 'ALREADY_FOLLOWING');
    throw e;
  }
}
export async function updateFollowSettings(db: D1Database, id: number, s: Partial<CopyFollowSettings>): Promise<void> {
  const cur = await getFollow(db, id);
  if (!cur || cur.status !== 'active') throw new HttpError(404, '따라가는 중이 아니에요', 'NOT_FOLLOWING');
  const next = { ...cur.settings, ...s };
  // 따라갈 돈을 바꾸면 현재값도 같은 비율로 (실현손익은 유지)
  const nowAmount = next.copyAmount !== cur.settings.copyAmount ? next.copyAmount + cur.realizedPnl : cur.copyAmountNow;
  await db.prepare('UPDATE copy_follows SET copy_amount = ?, copy_amount_now = ?, loss_limit_pct = ?, max_leverage = ?, sl_roi = ? WHERE id = ?').bind(next.copyAmount, nowAmount, next.lossLimitPct, next.maxLeverage, next.slRoi, id).run();
  invalidateUser(cur.followerId);
}
/** 카피 특약 재동의 (버전만 올라간 경우). active 팔로우만 */
export async function reagreeFollow(db: D1Database, id: number, termsVersion: string): Promise<boolean> {
  const r = await db.prepare("UPDATE copy_follows SET terms_version = ?, agreed_at = ? WHERE id = ? AND status = 'active'").bind(termsVersion, Date.now(), id).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 고수 약관 재동의 (승인·중지·대기 상태 그대로, 버전·소개만 갱신) */
export async function reagreeMaster(db: D1Database, userId: number, termsVersion: string, intro: string | null): Promise<void> {
  await db.prepare('UPDATE copy_masters SET terms_version = ?, intro = COALESCE(?, intro) WHERE user_id = ?').bind(termsVersion, intro, userId).run();
  invalidateUser(userId);
}
export async function stopFollow(db: D1Database, id: number, reason: CopyStopReason): Promise<boolean> {
  const r = await db.prepare("UPDATE copy_follows SET status = 'stopped', stopped_at = ?, stop_reason = ? WHERE id = ? AND status = 'active'").bind(Date.now(), reason, id).run();
  return (r.meta.changes ?? 0) > 0;
}
/**
 * 사용자의 active 팔로우 정지 (키 삭제·모드 전환·신분증 거절·탈퇴 시). 정지됐으면 true.
 * 이 경로들은 포지션을 정리하지 않으므로 장부(copy_positions)도 지운다 — 남은 포지션은 그때부터 사용자 본인 것 (다음 팔로우가 남의 장부를 이어받지 않게)
 */
export async function stopFollowsOfUser(db: D1Database, followerId: number, reason: CopyStopReason): Promise<boolean> {
  const active = await getActiveFollow(db, followerId);
  const r = await db.prepare("UPDATE copy_follows SET status = 'stopped', stopped_at = ?, stop_reason = ? WHERE follower_id = ? AND status = 'active'").bind(Date.now(), reason, followerId).run();
  if ((r.meta.changes ?? 0) > 0) {
    // 정리 없이 멈추므로 장부에 남은 포지션을 "정리하지 못한 포지션" 으로 남겨 사용자에게 알린다 (D1 0024). 지우는 건 그대로
    if (active) await snapshotLeftovers(db, active, reason).catch(() => 0);
    await deleteCopyPositions(db, followerId);
  }
  invalidateUser(followerId);
  return (r.meta.changes ?? 0) > 0;
}
/** 마스터 중지·거부 시 그 마스터의 팔로우 전부 정지 + 그 마스터를 따라 들어간 장부 삭제(포지션은 거래소에 남는다 — 손절은 걸려 있음). 정지된 수 */
export async function stopFollowsOfMaster(db: D1Database, masterId: number, reason: CopyStopReason): Promise<number> {
  // 멈추기 전에 active 팔로우별 장부를 "정리하지 못한 포지션" 으로 남긴다 (포지션은 거래소에 남는다)
  const active = await db.prepare("SELECT * FROM copy_follows WHERE master_id = ? AND status = 'active'").bind(masterId).all<RawFollow>().then((x) => (x.results ?? []).map(toFollow)).catch(() => [] as FollowRow[]);
  for (const f of active) await snapshotLeftovers(db, f, reason).catch(() => 0);
  const r = await db.prepare("UPDATE copy_follows SET status = 'stopped', stopped_at = ?, stop_reason = ? WHERE master_id = ? AND status = 'active'").bind(Date.now(), reason, masterId).run();
  if ((r.meta.changes ?? 0) > 0) await db.prepare('DELETE FROM copy_positions WHERE master_id = ?').bind(masterId).run();
  return r.meta.changes ?? 0;
}
export async function addRealizedPnl(db: D1Database, followId: number, delta: number): Promise<void> {
  await db.prepare('UPDATE copy_follows SET realized_pnl = realized_pnl + ?, copy_amount_now = copy_amount_now + ? WHERE id = ?').bind(delta, delta, followId).run();
}
export async function countFollowers(db: D1Database, masterId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) n FROM copy_follows WHERE master_id = ? AND status = 'active'").bind(masterId).first<{ n: number }>();
  return r?.n ?? 0;
}
/**
 * 실행 대상 팔로워: active + 신분증 승인 + 임시 비밀번호 아님 + 탈퇴 아님. 실거래 키 유무는 실행 시 확인.
 * 약관·특약이 구버전이어도 목록에 남긴다 — 정리(close/reduce)·손절 복제·손실 한도는 계속 돌아야 한다. 새 진입(open/add)만 실행기에서 막는다 (userTermsVersion 참고)
 */
export async function listActiveFollowers(db: D1Database, masterId: number): Promise<FollowRow[]> {
  const r = await db.prepare(`SELECT f.*, u.terms_version AS user_terms_version FROM copy_follows f JOIN users u ON u.id = f.follower_id
    WHERE f.master_id = ? AND f.status = 'active' AND u.deleted_at IS NULL AND u.kyc_status = 'approved' AND COALESCE(u.must_change_pw, 0) = 0
    ORDER BY f.started_at ASC`).bind(masterId).all<RawFollow & { user_terms_version: string | null }>();
  return (r.results ?? []).map((x) => ({ ...toFollow(x), userTermsVersion: x.user_terms_version }));
}
/** 새 진입(open/add) 게이트: 이용약관·카피 특약 모두 최신이어야 한다 */
export const entryTermsOk = (f: FollowRow): boolean => f.termsVersion === COPY_TERMS_VERSION && (f.userTermsVersion === undefined || f.userTermsVersion === TERMS_VERSION);
export async function listFollowsAdmin(db: D1Database, limit = 200): Promise<(FollowRow & { followerLoginId: string; masterNickname: string })[]> {
  const r = await db.prepare(`SELECT f.*, u.login_id AS follower_login_id, m.nickname AS master_nickname FROM copy_follows f JOIN users u ON u.id = f.follower_id JOIN copy_masters m ON m.user_id = f.master_id
    ORDER BY f.status = 'active' DESC, f.started_at DESC LIMIT ?`).bind(limit).all<RawFollow & { follower_login_id: string; master_nickname: string }>();
  return (r.results ?? []).map((x) => ({ ...toFollow(x), followerLoginId: x.follower_login_id, masterNickname: x.master_nickname }));
}
export async function listFollowersOfMaster(db: D1Database, masterId: number): Promise<(FollowRow & { followerLoginId: string })[]> {
  const r = await db.prepare("SELECT f.*, u.login_id AS follower_login_id FROM copy_follows f JOIN users u ON u.id = f.follower_id WHERE f.master_id = ? AND f.status = 'active' ORDER BY f.started_at ASC").bind(masterId).all<RawFollow & { follower_login_id: string }>();
  return (r.results ?? []).map((x) => ({ ...toFollow(x), followerLoginId: x.follower_login_id }));
}
export const copyTermsOutdated = (f: FollowRow | null): boolean => !!f && f.termsVersion !== COPY_TERMS_VERSION;

// ---------- 마스터 감시 상태 ----------
export async function getMasterState(db: D1Database, masterId: number): Promise<Map<Symbol, MasterStateRow>> {
  const r = await db.prepare('SELECT symbol, direction, contracts, entry_price, leverage, equity, sl_price, tp_price, updated_at FROM copy_master_state WHERE master_id = ?').bind(masterId).all<{ symbol: string; direction: string | null; contracts: number; entry_price: number | null; leverage: number | null; equity: number | null; sl_price: number | null; tp_price: number | null; updated_at: number }>();
  return new Map((r.results ?? []).map((x) => [x.symbol as Symbol, { symbol: x.symbol as Symbol, direction: (x.direction as Direction | null) ?? null, contracts: x.contracts, entryPrice: x.entry_price, leverage: x.leverage, equity: x.equity, slPrice: x.sl_price ?? null, tpPrice: x.tp_price ?? null, updatedAt: x.updated_at }]));
}
export async function upsertMasterState(db: D1Database, masterId: number, s: Omit<MasterStateRow, 'updatedAt'>): Promise<void> {
  await db.prepare(`INSERT INTO copy_master_state (master_id, symbol, direction, contracts, entry_price, leverage, equity, sl_price, tp_price, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(master_id, symbol) DO UPDATE SET direction = excluded.direction, contracts = excluded.contracts, entry_price = excluded.entry_price, leverage = excluded.leverage, equity = excluded.equity, sl_price = excluded.sl_price, tp_price = excluded.tp_price, updated_at = excluded.updated_at`)
    .bind(masterId, s.symbol, s.direction, s.contracts, s.entryPrice, s.leverage, s.equity, s.slPrice ?? null, s.tpPrice ?? null, Date.now()).run();
}
/** 재승인 시 감시 기준선 삭제 → 첫 폴링이 기준선만 다시 잡는다 (중지 동안 바뀐 포지션을 이벤트로 오해하지 않게) */
export async function clearMasterState(db: D1Database, masterId: number): Promise<void> {
  await db.prepare('DELETE FROM copy_master_state WHERE master_id = ?').bind(masterId).run();
}
export async function getMasterMeta(db: D1Database, masterId: number): Promise<MasterMeta> {
  const r = await db.prepare('SELECT seq, ws_ok, last_poll_at, last_error FROM copy_master_meta WHERE master_id = ?').bind(masterId).first<{ seq: number; ws_ok: number; last_poll_at: number | null; last_error: string | null }>();
  return r ? { seq: r.seq, wsOk: !!r.ws_ok, lastPollAt: r.last_poll_at, lastError: r.last_error } : { seq: 0, wsOk: false, lastPollAt: null, lastError: null };
}
/** 이벤트 삽입문 (db.batch 용). OR IGNORE — 같은 id 는 무시 */
export function insertEventStmt(db: D1Database, e: Omit<CopyEvent, 'processedAt' | 'followerCount' | 'okCount' | 'failCount' | 'skippedCount'>): D1PreparedStatement {
  return db.prepare('INSERT OR IGNORE INTO copy_events (id, master_id, seq, symbol, kind, direction, before_contracts, after_contracts, price, leverage, master_equity, sl_price, tp_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(e.id, e.masterId, e.seq, e.symbol, e.kind, e.direction, e.beforeContracts, e.afterContracts, e.price, e.leverage, e.masterEquity, e.slPrice ?? null, e.tpPrice ?? null, e.createdAt);
}
/** 상태 갱신문 (db.batch 용) */
export function upsertMasterStateStmt(db: D1Database, masterId: number, s: Omit<MasterStateRow, 'updatedAt'>): D1PreparedStatement {
  return db.prepare(`INSERT INTO copy_master_state (master_id, symbol, direction, contracts, entry_price, leverage, equity, sl_price, tp_price, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(master_id, symbol) DO UPDATE SET direction = excluded.direction, contracts = excluded.contracts, entry_price = excluded.entry_price, leverage = excluded.leverage, equity = excluded.equity, sl_price = excluded.sl_price, tp_price = excluded.tp_price, updated_at = excluded.updated_at`)
    .bind(masterId, s.symbol, s.direction, s.contracts, s.entryPrice, s.leverage, s.equity, s.slPrice ?? null, s.tpPrice ?? null, Date.now());
}
/** seq 저장문 (db.batch 용). 감시 DO 가 메모리·DO 저장소에서 세는 seq 를 D1 에도 남긴다 (뒤로 가지 않게 MAX) */
export function setMasterSeqStmt(db: D1Database, masterId: number, seq: number): D1PreparedStatement {
  return db.prepare('INSERT INTO copy_master_meta (master_id, seq) VALUES (?, ?) ON CONFLICT(master_id) DO UPDATE SET seq = MAX(seq, excluded.seq)').bind(masterId, seq);
}
/** 다음 이벤트 번호 (마스터별 단조 증가, 원자적) — 감시 DO 밖(테스트·관리 도구)용. DO 는 저장소의 seq 를 쓴다 */
export async function nextSeq(db: D1Database, masterId: number): Promise<number> {
  await db.prepare('INSERT INTO copy_master_meta (master_id, seq) VALUES (?, 1) ON CONFLICT(master_id) DO UPDATE SET seq = seq + 1').bind(masterId).run();
  const r = await db.prepare('SELECT seq FROM copy_master_meta WHERE master_id = ?').bind(masterId).first<{ seq: number }>();
  return r?.seq ?? 1;
}
export async function markMasterPoll(db: D1Database, masterId: number, wsOk: boolean, error: string | null): Promise<void> {
  await db.prepare('INSERT INTO copy_master_meta (master_id, ws_ok, last_poll_at, last_error) VALUES (?, ?, ?, ?) ON CONFLICT(master_id) DO UPDATE SET ws_ok = excluded.ws_ok, last_poll_at = excluded.last_poll_at, last_error = excluded.last_error').bind(masterId, wsOk ? 1 : 0, Date.now(), error).run();
}

// ---------- 이벤트 ----------
export async function insertEvent(db: D1Database, e: Omit<CopyEvent, 'processedAt' | 'followerCount' | 'okCount' | 'failCount' | 'skippedCount'>): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO copy_events (id, master_id, seq, symbol, kind, direction, before_contracts, after_contracts, price, leverage, master_equity, sl_price, tp_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(e.id, e.masterId, e.seq, e.symbol, e.kind, e.direction, e.beforeContracts, e.afterContracts, e.price, e.leverage, e.masterEquity, e.slPrice ?? null, e.tpPrice ?? null, e.createdAt).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function getEvent(db: D1Database, id: string): Promise<CopyEvent | null> {
  const r = await db.prepare('SELECT * FROM copy_events WHERE id = ?').bind(id).first<RawEvent>();
  return r ? toEvent(r) : null;
}
/** 같은 마스터·종목에 더 최신 이벤트가 있는가 (유실 복구로 늦게 도는 진입·손절·배율 이벤트는 건너뛴다 — 정리는 재생해도 안전) */
export async function hasNewerEvent(db: D1Database, masterId: number, symbol: Symbol, seq: number): Promise<boolean> {
  const r = await db.prepare('SELECT 1 AS x FROM copy_events WHERE master_id = ? AND symbol = ? AND seq > ? LIMIT 1').bind(masterId, symbol, seq).first<{ x: number }>();
  return !!r;
}
export async function finishEvent(db: D1Database, id: string, followers: number, ok: number, fail: number, skipped: number): Promise<void> {
  await db.prepare('UPDATE copy_events SET processed_at = ?, follower_count = ?, ok_count = ?, fail_count = ?, skipped_count = ? WHERE id = ?').bind(Date.now(), followers, ok, fail, skipped, id).run();
}
export async function listEvents(db: D1Database, masterId: number, limit = 30): Promise<CopyEvent[]> {
  const r = await db.prepare('SELECT * FROM copy_events WHERE master_id = ? ORDER BY created_at DESC LIMIT ?').bind(masterId, limit).all<RawEvent>();
  return (r.results ?? []).map(toEvent);
}
export async function listRecentEvents(db: D1Database, limit = 50): Promise<CopyEvent[]> {
  const r = await db.prepare('SELECT * FROM copy_events ORDER BY created_at DESC LIMIT ?').bind(limit).all<RawEvent>();
  return (r.results ?? []).map(toEvent);
}

// ---------- 실행 기록 ----------
export async function insertCopyExecution(db: D1Database, eventId: string, followerId: number, mode: Mode, status: CopyExecution['status'], detail: string | null, orderId: string | null, contracts: number): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO copy_executions (event_id, follower_id, mode, status, detail, order_id, contracts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(eventId, followerId, mode, status, detail, orderId, contracts, Date.now()).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 여러 건 한 번에 (시세 오래됨 등 일괄 실패 기록) */
export async function insertCopyExecutions(db: D1Database, rows: { eventId: string; followerId: number; mode: Mode; status: CopyExecution['status']; detail: string | null }[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  await db.batch(rows.map((r) => db.prepare('INSERT OR IGNORE INTO copy_executions (event_id, follower_id, mode, status, detail, order_id, contracts, created_at) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)').bind(r.eventId, r.followerId, r.mode, r.status, r.detail, now)));
}
/** 실행 선점: 주문을 내기 전에 pending 행을 먼저 넣는다. 이미 있으면(다른 샤드·재시도가 선점) false → 주문하지 않는다 (at-least-once 중복 주문 방지). clientOrderId 는 주문 전에 정해 함께 남긴다 */
export async function claimCopyExecution(db: D1Database, eventId: string, followerId: number, mode: Mode, clientOrderId: string | null = null): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO copy_executions (event_id, follower_id, mode, status, detail, order_id, contracts, created_at, client_order_id) VALUES (?, ?, ?, 'pending', NULL, NULL, 0, ?, ?)").bind(eventId, followerId, mode, Date.now(), clientOrderId).run();
  return (r.meta.changes ?? 0) > 0;
}
/** 주문 표식: cp<masterId>s<seq>f<followerId> (≤32 영숫자). 이벤트·팔로워마다 유일 */
export const copyClientOrderId = (masterId: number, seq: number, followerId: number): string => `cp${masterId}s${seq}f${followerId}`.slice(0, 32);
/** olderThanMs 넘게 pending 인 행 (만료 처리 전에 거래소에서 체결 여부를 되찾기 위해) */
export async function listExpiredPendingExecutions(db: D1Database, eventId: string, olderThanMs: number): Promise<{ followerId: number; mode: Mode; clientOrderId: string | null }[]> {
  const r = await db.prepare("SELECT follower_id, mode, client_order_id FROM copy_executions WHERE event_id = ? AND status = 'pending' AND created_at <= ?").bind(eventId, Date.now() - olderThanMs).all<{ follower_id: number; mode: string; client_order_id: string | null }>();
  return (r.results ?? []).map((x) => ({ followerId: x.follower_id, mode: x.mode as Mode, clientOrderId: x.client_order_id }));
}
/** 선점한 행에 결과 기록 */
export async function updateCopyExecution(db: D1Database, eventId: string, followerId: number, mode: Mode, status: CopyExecution['status'], detail: string | null, orderId: string | null, contracts: number, fillPrice: number | null = null): Promise<void> {
  await db.prepare('UPDATE copy_executions SET mode = ?, status = ?, detail = ?, order_id = ?, contracts = ?, fill_price = ? WHERE event_id = ? AND follower_id = ?').bind(mode, status, detail, orderId, contracts, fillPrice != null && fillPrice > 0 ? fillPrice : null, eventId, followerId).run();
}
export const PENDING_UNKNOWN_DETAIL = '실행 결과를 확인하지 못했어요 (중복 주문을 막기 위해 다시 실행하지 않음 — 포지션을 직접 확인하세요)';
/** olderThanMs 넘게 pending 인 행 = 실행기가 죽은 것. 결과 불명 실패로 닫고 다시 주문하지 않는다. 바뀐 수 */
export async function expirePendingExecutions(db: D1Database, eventId: string, olderThanMs: number): Promise<number> {
  const r = await db.prepare("UPDATE copy_executions SET status = 'failed', detail = ? WHERE event_id = ? AND status = 'pending' AND created_at <= ?").bind(PENDING_UNKNOWN_DETAIL, eventId, Date.now() - olderThanMs).run();
  return r.meta.changes ?? 0;
}
/** 이 이벤트에 행이 있는 팔로워 전부 (ok/failed/skipped + 아직 pending 인 선점 행 포함 — 어느 쪽이든 다시 실행하지 않는다) */
export async function executedFollowerIds(db: D1Database, eventId: string): Promise<Set<number>> {
  const r = await db.prepare('SELECT follower_id FROM copy_executions WHERE event_id = ?').bind(eventId).all<{ follower_id: number }>();
  return new Set((r.results ?? []).map((x) => x.follower_id));
}
export async function listEventExecutions(db: D1Database, eventId: string): Promise<(CopyExecution & { loginId: string })[]> {
  const r = await db.prepare('SELECT e.*, u.login_id, v.symbol, v.kind, v.direction, v.price, v.close_reason FROM copy_executions e JOIN users u ON u.id = e.follower_id LEFT JOIN copy_events v ON v.id = e.event_id WHERE e.event_id = ? ORDER BY e.status, e.created_at').bind(eventId).all<RawExec & { login_id: string }>();
  return (r.results ?? []).map((x) => ({ ...toExec(x), loginId: x.login_id }));
}
export async function listMyCopyExecutions(db: D1Database, followerId: number, limit = 50): Promise<CopyExecution[]> {
  const r = await db.prepare('SELECT e.*, v.symbol, v.kind, v.direction, v.price, v.close_reason FROM copy_executions e JOIN copy_events v ON v.id = e.event_id WHERE e.follower_id = ? ORDER BY e.created_at DESC LIMIT ?').bind(followerId, limit).all<RawExec>();
  return (r.results ?? []).map(toExec);
}
/** 팔로워의 마지막 실행 — 이 마스터의 이벤트만 (다른 고수를 따랐던 기록은 보이지 않게) */
export async function lastExecutionOf(db: D1Database, followerId: number, masterId: number): Promise<{ status: CopyExecution['status']; detail: string | null; createdAt: number; slippagePct: number | null } | null> {
  const r = await db.prepare('SELECT e.status, e.detail, e.created_at, e.fill_price, v.kind, v.direction, v.price FROM copy_executions e JOIN copy_events v ON v.id = e.event_id WHERE e.follower_id = ? AND v.master_id = ? ORDER BY e.created_at DESC LIMIT 1').bind(followerId, masterId).first<{ status: string; detail: string | null; created_at: number; fill_price: number | null; kind: string; direction: string; price: number }>();
  return r ? { status: r.status as CopyExecution['status'], detail: r.detail, createdAt: r.created_at, slippagePct: slippagePctOf(r.kind as CopyEventKind, r.direction as Direction, r.price, r.fill_price) } : null;
}
/** 팔로워의 최근 days 일 슬리피지 평균 % (open/add/close 성공 + 체결가 기록분만). 기록이 없으면 null */
export async function avgSlippagePct(db: D1Database, followerId: number, days = 30): Promise<number | null> {
  const r = await db.prepare(`SELECT v.kind, v.direction, v.price, e.fill_price FROM copy_executions e JOIN copy_events v ON v.id = e.event_id
    WHERE e.follower_id = ? AND e.status = 'ok' AND e.fill_price IS NOT NULL AND e.fill_price > 0 AND e.created_at >= ? AND v.kind IN ('open', 'add', 'close', 'reduce')`).bind(followerId, Date.now() - days * 86_400_000).all<{ kind: string; direction: string; price: number; fill_price: number }>();
  const vals = (r.results ?? []).map((x) => slippagePctOf(x.kind as CopyEventKind, x.direction as Direction, x.price, x.fill_price)).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10000) / 10000;
}
/** 고수 close 이벤트의 정리 사유 기록 (감시 DO 가 팬아웃 뒤 채운다) */
export async function setEventCloseReason(db: D1Database, eventId: string, reason: CopyCloseReason): Promise<void> {
  await db.prepare('UPDATE copy_events SET close_reason = ? WHERE id = ?').bind(reason, eventId).run();
}
/** 거래 내역 출처 판정용: 이 사용자의 카피 주문 id → 이벤트 id (95일) */
export async function loadCopyTags(db: D1Database, followerId: number): Promise<Map<string, { eventId: string }>> {
  const r = await db.prepare("SELECT order_id, event_id FROM copy_executions WHERE follower_id = ? AND order_id IS NOT NULL AND status = 'ok' AND created_at >= ?").bind(followerId, Date.now() - 95 * 86_400_000).all<{ order_id: string; event_id: string }>();
  return new Map((r.results ?? []).map((x) => [x.order_id, { eventId: x.event_id }]));
}

// ---------- 팔로워 장부 포지션 ----------
export async function getCopyPosition(db: D1Database, followerId: number, symbol: Symbol): Promise<CopyPositionRow | null> {
  const r = await db.prepare('SELECT * FROM copy_positions WHERE follower_id = ? AND symbol = ?').bind(followerId, symbol).first<RawPos>();
  return r ? toPos(r) : null;
}
/** 팔로워 장부. masterId 를 주면 그 마스터를 따라 들어간 것만 (실행기는 항상 현재 마스터로 한정) */
export async function listCopyPositions(db: D1Database, followerId: number, masterId?: number): Promise<CopyPositionRow[]> {
  const r = masterId === undefined
    ? await db.prepare('SELECT * FROM copy_positions WHERE follower_id = ? ORDER BY symbol').bind(followerId).all<RawPos>()
    : await db.prepare('SELECT * FROM copy_positions WHERE follower_id = ? AND master_id = ? ORDER BY symbol').bind(followerId, masterId).all<RawPos>();
  return (r.results ?? []).map(toPos);
}
export async function listCopyPositionsOfMaster(db: D1Database, masterId: number): Promise<CopyPositionRow[]> {
  const r = await db.prepare('SELECT * FROM copy_positions WHERE master_id = ? ORDER BY follower_id, symbol').bind(masterId).all<RawPos>();
  return (r.results ?? []).map(toPos);
}
export async function upsertCopyPosition(db: D1Database, p: Omit<CopyPositionRow, 'updatedAt' | 'openedAt'> & { openedAt?: number }): Promise<void> {
  const now = Date.now();
  await db.prepare(`INSERT INTO copy_positions (follower_id, master_id, symbol, direction, contracts, entry_price, leverage, sl_price, tp_price, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(follower_id, symbol) DO UPDATE SET master_id = excluded.master_id, direction = excluded.direction, contracts = excluded.contracts, entry_price = excluded.entry_price, leverage = excluded.leverage, sl_price = excluded.sl_price, tp_price = excluded.tp_price, updated_at = excluded.updated_at`)
    .bind(p.followerId, p.masterId, p.symbol, p.direction, p.contracts, p.entryPrice, p.leverage, p.slPrice ?? null, p.tpPrice ?? null, p.openedAt ?? now, now).run();
}
/** 장부에서 contracts 만큼 뺀다. 0 이하가 되면 행 삭제. 남은 계약 수 반환 */
export async function reduceCopyPosition(db: D1Database, followerId: number, symbol: Symbol, contracts: number): Promise<number> {
  const cur = await getCopyPosition(db, followerId, symbol);
  if (!cur) return 0;
  const left = Math.max(0, cur.contracts - contracts);
  if (left === 0) await db.prepare('DELETE FROM copy_positions WHERE follower_id = ? AND symbol = ?').bind(followerId, symbol).run();
  else await db.prepare('UPDATE copy_positions SET contracts = ?, updated_at = ? WHERE follower_id = ? AND symbol = ?').bind(left, Date.now(), followerId, symbol).run();
  return left;
}
export async function setCopyPositionTpSl(db: D1Database, followerId: number, symbol: Symbol, slPrice: number | null | undefined, tpPrice: number | null | undefined): Promise<void> {
  // undefined = 그대로, null = 삭제
  await db.prepare('UPDATE copy_positions SET sl_price = CASE WHEN ? THEN ? ELSE sl_price END, tp_price = CASE WHEN ? THEN ? ELSE tp_price END, updated_at = ? WHERE follower_id = ? AND symbol = ?')
    .bind(slPrice !== undefined ? 1 : 0, slPrice ?? null, tpPrice !== undefined ? 1 : 0, tpPrice ?? null, Date.now(), followerId, symbol).run();
}
export async function setCopyPositionLeverage(db: D1Database, followerId: number, symbol: Symbol, leverage: number): Promise<void> {
  await db.prepare('UPDATE copy_positions SET leverage = ?, updated_at = ? WHERE follower_id = ? AND symbol = ?').bind(leverage, Date.now(), followerId, symbol).run();
}
export async function deleteCopyPositions(db: D1Database, followerId: number): Promise<void> {
  await db.prepare('DELETE FROM copy_positions WHERE follower_id = ?').bind(followerId).run();
}

// ---------- 정리하지 못한 포지션 (D1 0024) ----------
export type LeftoverInput = Pick<CopyPositionRow, 'symbol' | 'direction' | 'contracts' | 'entryPrice' | 'leverage' | 'slPrice' | 'tpPrice'>;
/** 여러 건 삽입. 같은 팔로우·종목에 아직 확인 안 된 행이 있으면 그 행의 수량·사유만 갱신 (손실 한도 재시도가 15초마다 겹쌓이지 않게) */
export async function insertLeftovers(db: D1Database, follow: Pick<FollowRow, 'id' | 'followerId' | 'masterId'>, reason: CopyLeftoverReason, rows: LeftoverInput[]): Promise<number> {
  const live = rows.filter((r) => r.contracts > 0);
  if (live.length === 0) return 0;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of live) {
    stmts.push(db.prepare('UPDATE copy_leftovers SET contracts = ?, entry_price = ?, leverage = ?, sl_price = ?, tp_price = ?, reason = ?, created_at = ? WHERE follow_id = ? AND symbol = ? AND acked_at IS NULL')
      .bind(r.contracts, r.entryPrice, r.leverage, r.slPrice ?? null, r.tpPrice ?? null, reason, now, follow.id, r.symbol));
    stmts.push(db.prepare(`INSERT INTO copy_leftovers (follow_id, follower_id, master_id, symbol, direction, contracts, entry_price, leverage, sl_price, tp_price, reason, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM copy_leftovers WHERE follow_id = ? AND symbol = ? AND acked_at IS NULL)`)
      .bind(follow.id, follow.followerId, follow.masterId, r.symbol, r.direction, r.contracts, r.entryPrice, r.leverage, r.slPrice ?? null, r.tpPrice ?? null, reason, now, follow.id, r.symbol));
  }
  await db.batch(stmts);
  return live.length;
}
/** 팔로우가 정리 없이 멈출 때: 이 고수를 따라 들어간 장부(수량 > 0)를 그대로 스냅샷. 남긴 수 */
export async function snapshotLeftovers(db: D1Database, follow: Pick<FollowRow, 'id' | 'followerId' | 'masterId'>, reason: CopyLeftoverReason, only?: Symbol[]): Promise<CopyPositionRow[]> {
  const books = (await listCopyPositions(db, follow.followerId, follow.masterId)).filter((b) => b.contracts > 0 && (!only || only.includes(b.symbol)));
  await insertLeftovers(db, follow, reason, books);
  return books;
}
export async function listLeftovers(db: D1Database, followerId: number, unackedOnly = true, followId?: number): Promise<ReturnType<typeof toLeftover>[]> {
  const sql = `SELECT * FROM copy_leftovers WHERE follower_id = ?${unackedOnly ? ' AND acked_at IS NULL' : ''}${followId !== undefined ? ' AND follow_id = ?' : ''} ORDER BY created_at DESC, symbol LIMIT 50`;
  const stmt = followId !== undefined ? db.prepare(sql).bind(followerId, followId) : db.prepare(sql).bind(followerId);
  const r = await stmt.all<RawLeftover>();
  return (r.results ?? []).map(toLeftover);
}
/** 사용자가 확인함 → 화면에서 사라진다. 확인 처리된 수 */
export async function ackLeftovers(db: D1Database, followerId: number): Promise<number> {
  const r = await db.prepare('UPDATE copy_leftovers SET acked_at = ? WHERE follower_id = ? AND acked_at IS NULL').bind(Date.now(), followerId).run();
  return r.meta.changes ?? 0;
}
/** 관리자 목록용: 팔로우별 미확인 남은 포지션 수 */
export async function countLeftoversByFollow(db: D1Database): Promise<Map<number, number>> {
  const r = await db.prepare('SELECT follow_id, COUNT(*) n FROM copy_leftovers WHERE acked_at IS NULL GROUP BY follow_id').all<{ follow_id: number; n: number }>();
  return new Map((r.results ?? []).map((x) => [x.follow_id, x.n]));
}

// ---------- 직접 주문 가드·포지션 배지 (routes/trade.ts) ----------
/** 사용자의 active 팔로우 + 그 고수 장부 종목 (한 번의 조회). 팔로우가 없으면 null. /api/state 3초 폴링용 3초 캐시 */
const badgeCache = new Map<number, { at: number; value: Promise<{ masterId: number; masterNickname: string; symbols: Symbol[] } | null> }>();
const BADGE_CACHE_MS = 3_000;
export async function copyBadgesOf(db: D1Database, followerId: number, fresh = false): Promise<{ masterId: number; masterNickname: string; symbols: Symbol[] } | null> {
  const hit = badgeCache.get(followerId);
  if (!fresh && hit && Date.now() - hit.at < BADGE_CACHE_MS) return hit.value;
  if (badgeCache.size > 2000) for (const [k, v] of badgeCache) if (Date.now() - v.at > BADGE_CACHE_MS) badgeCache.delete(k);
  const value = (async () => {
    const r = await db.prepare(`SELECT f.master_id, m.nickname, p.symbol FROM copy_follows f LEFT JOIN copy_masters m ON m.user_id = f.master_id
      LEFT JOIN copy_positions p ON p.follower_id = f.follower_id AND p.master_id = f.master_id AND p.contracts > 0 WHERE f.follower_id = ? AND f.status = 'active'`).bind(followerId).all<{ master_id: number; nickname: string | null; symbol: string | null }>();
    const rows = r.results ?? [];
    if (rows.length === 0) return null;
    return { masterId: rows[0].master_id, masterNickname: rows[0].nickname ?? '(삭제된 고수)', symbols: rows.map((x) => x.symbol).filter((x): x is string => !!x) as Symbol[] };
  })().catch((e) => { badgeCache.delete(followerId); throw e; });
  badgeCache.set(followerId, { at: Date.now(), value });
  return value;
}
/** 장부 수량을 실제 수량으로 줄인다 (실제 < 장부 일 때만 — 직접 일부 정리한 경우). 0 이하면 삭제. 바뀐 뒤 수량 */
export async function clampCopyPosition(db: D1Database, followerId: number, symbol: Symbol, realContracts: number): Promise<number> {
  const cur = await getCopyPosition(db, followerId, symbol);
  if (!cur || realContracts >= cur.contracts) return cur?.contracts ?? 0;
  return reduceCopyPosition(db, followerId, symbol, cur.contracts - Math.max(0, Math.floor(realContracts)));
}
/** 이 고수의 팔로워 중 장부 포지션이 하나라도 있는가 (손실 한도 점검 주기 결정: 있으면 15초, 없으면 60초) */
export async function masterHasBookPositions(db: D1Database, masterId: number): Promise<boolean> {
  const r = await db.prepare('SELECT 1 AS x FROM copy_positions WHERE master_id = ? LIMIT 1').bind(masterId).first<{ x: number }>();
  return !!r;
}

// ---------- 마스터 통계 (5분 캐시) ----------
interface RawStats { master_id?: number; days30_pnl: number; days30_roi: number; win_rate: number; trades: number; recent_json?: string | null; updated_at: number; roi_since?: number | null; winrate_since?: number | null; recent_since?: number | null }
function parseRecent(json: string | null | undefined): MasterRecentTrade[] {
  if (!json) return [];
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? (v as MasterRecentTrade[]) : []; } catch { return []; }
}
const toStats = (r: RawStats): MasterStats => ({ days30Pnl: r.days30_pnl, days30Roi: r.days30_roi, winRate: r.win_rate, trades: r.trades, recent: parseRecent(r.recent_json), updatedAt: r.updated_at, since: { roi: r.roi_since ?? 0, winRate: r.winrate_since ?? 0, recent: r.recent_since ?? 0 } });
export async function getMasterStats(db: D1Database, masterId: number): Promise<MasterStats | null> {
  const r = await db.prepare('SELECT days30_pnl, days30_roi, win_rate, trades, recent_json, updated_at, roi_since, winrate_since, recent_since FROM copy_master_stats WHERE master_id = ?').bind(masterId).first<RawStats>();
  return r ? toStats(r) : null;
}
export async function upsertMasterStats(db: D1Database, masterId: number, s: Omit<MasterStats, 'updatedAt'>): Promise<void> {
  await db.prepare('INSERT INTO copy_master_stats (master_id, days30_pnl, days30_roi, win_rate, trades, recent_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(master_id) DO UPDATE SET days30_pnl = excluded.days30_pnl, days30_roi = excluded.days30_roi, win_rate = excluded.win_rate, trades = excluded.trades, recent_json = excluded.recent_json, updated_at = excluded.updated_at')
    .bind(masterId, s.days30Pnl, s.days30Roi, s.winRate, s.trades, JSON.stringify(s.recent ?? []), Date.now()).run();
}
/** 관리자 전용: 지표별 초기화 — 기준 시각을 지금으로 올린다 (행이 없으면 만든다). 다음 재계산부터 그 이후 마감 거래만 반영 */
export async function resetMasterStats(db: D1Database, masterId: number, which: StatsMetric | 'all', now = Date.now()): Promise<void> {
  const cols = which === 'all' ? ['roi_since', 'winrate_since', 'recent_since'] : [{ roi: 'roi_since', winRate: 'winrate_since', recent: 'recent_since' }[which]];
  await db.prepare(`INSERT INTO copy_master_stats (master_id, updated_at, ${cols.join(', ')}) VALUES (?, 0, ${cols.map(() => '?').join(', ')})
    ON CONFLICT(master_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = 0`).bind(masterId, ...cols.map(() => now)).run();
}
export async function listMasterStats(db: D1Database): Promise<Map<number, MasterStats>> {
  const r = await db.prepare('SELECT master_id, days30_pnl, days30_roi, win_rate, trades, recent_json, updated_at, roi_since, winrate_since, recent_since FROM copy_master_stats').all<RawStats>();
  return new Map((r.results ?? []).map((x) => [x.master_id!, toStats(x)]));
}
export async function followerCounts(db: D1Database): Promise<Map<number, number>> {
  const r = await db.prepare("SELECT master_id, COUNT(*) n FROM copy_follows WHERE status = 'active' GROUP BY master_id").all<{ master_id: number; n: number }>();
  return new Map((r.results ?? []).map((x) => [x.master_id, x.n]));
}
/** 탈퇴 정리: 마스터면 팔로우 전부 정지 + 마스터 행 삭제, 팔로워면 정지 + 장부 삭제 */
export async function cleanupUserCopy(db: D1Database, userId: number): Promise<void> {
  await stopFollowsOfMaster(db, userId, 'master_suspended');
  await stopFollowsOfUser(db, userId, 'account_deleted');
  await db.batch([
    db.prepare('DELETE FROM copy_masters WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM copy_positions WHERE follower_id = ?').bind(userId),
    db.prepare('DELETE FROM copy_master_state WHERE master_id = ?').bind(userId),
    db.prepare('DELETE FROM copy_master_meta WHERE master_id = ?').bind(userId),
    db.prepare('DELETE FROM copy_master_stats WHERE master_id = ?').bind(userId),
  ]);
}

// ---------- 라우트 보조 (서버 B 추가) ----------
/** 승인 마스터 전원의 현재 보유 방향 (마스터 목록 카드용, 수량·금액 없음). 한 번의 조회 */
export async function listOpenMasterPositions(db: D1Database): Promise<Map<number, { symbol: Symbol; direction: Direction }[]>> {
  const r = await db.prepare('SELECT master_id, symbol, direction FROM copy_master_state WHERE contracts > 0 AND direction IS NOT NULL ORDER BY master_id, symbol').all<{ master_id: number; symbol: string; direction: string }>();
  const out = new Map<number, { symbol: Symbol; direction: Direction }[]>();
  for (const x of r.results ?? []) {
    const list = out.get(x.master_id) ?? [];
    list.push({ symbol: x.symbol as Symbol, direction: x.direction as Direction });
    out.set(x.master_id, list);
  }
  return out;
}
/** 관리자 목록: 마스터 전원 + 아이디·모드·API 키 유무 (탈퇴 계정 제외) */
export async function listMastersAdmin(db: D1Database): Promise<(MasterRow & { loginId: string; mode: Mode; hasApiKey: boolean })[]> {
  const r = await db.prepare(`SELECT m.*, u.login_id, s.mode AS user_mode, (k.user_id IS NOT NULL) AS has_key FROM copy_masters m JOIN users u ON u.id = m.user_id
    LEFT JOIN settings s ON s.user_id = m.user_id LEFT JOIN api_keys k ON k.user_id = m.user_id WHERE u.deleted_at IS NULL ORDER BY m.applied_at ASC`).all<RawMaster & { login_id: string; user_mode: string | null; has_key: number }>();
  return (r.results ?? []).map((x) => ({ ...toMaster(x), loginId: x.login_id, mode: (x.user_mode === 'live' ? 'live' : 'paper') as Mode, hasApiKey: !!x.has_key }));   // paused 는 toMaster 가 채운다
}

// ---------- (서버 A 추가) 감시 DO 복구용 ----------
/** 만든 지 olderThanMs 가 지났는데 아직 처리되지 않은 이벤트 (팬아웃 호출이 유실됐을 때 다시 던진다 — CopyTrader 는 멱등) */
export async function listStaleEvents(db: D1Database, masterId: number, olderThanMs: number, limit = 20): Promise<CopyEvent[]> {
  const r = await db.prepare('SELECT * FROM copy_events WHERE master_id = ? AND processed_at IS NULL AND created_at <= ? ORDER BY seq ASC LIMIT ?').bind(masterId, Date.now() - olderThanMs, limit).all<RawEvent>();
  return (r.results ?? []).map(toEvent);
}

// ---------- (감사 A5) 고아 pending 복구용 ----------
/** 이벤트와 무관하게 olderThanMs 넘게 pending 인 실행 행 전부 (최대 limit). 코디네이터가 이벤트를 processed 로 닫은 뒤 남은 고아 행도 잡는다 — CopyTrader /recover-pending */
export async function listAllExpiredPendingExecutions(db: D1Database, olderThanMs: number, limit = 50): Promise<{ eventId: string; followerId: number; mode: Mode; clientOrderId: string | null }[]> {
  const r = await db.prepare("SELECT event_id, follower_id, mode, client_order_id FROM copy_executions WHERE status = 'pending' AND created_at < ? ORDER BY created_at ASC LIMIT ?").bind(Date.now() - olderThanMs, limit).all<{ event_id: string; follower_id: number; mode: string; client_order_id: string | null }>();
  return (r.results ?? []).map((x) => ({ eventId: x.event_id, followerId: x.follower_id, mode: x.mode as Mode, clientOrderId: x.client_order_id }));
}

/** 이벤트의 실거래 실행 중 아직 결론이 안 난 행(pending) + 실패로 기록된 행 — 관리자 '재확인' 이 거래소 주문 조회로 실제 체결을 장부에 올릴 대상 */
export async function listUnsettledLiveExecutions(db: D1Database, eventId: string): Promise<{ followerId: number; mode: Mode; clientOrderId: string | null; status: string }[]> {
  const r = await db.prepare("SELECT follower_id, mode, client_order_id, status FROM copy_executions WHERE event_id = ? AND mode = 'live' AND status IN ('pending', 'failed') AND client_order_id IS NOT NULL").bind(eventId).all<{ follower_id: number; mode: string; client_order_id: string | null; status: string }>();
  return (r.results ?? []).map((x) => ({ followerId: x.follower_id, mode: x.mode as Mode, clientOrderId: x.client_order_id, status: x.status }));
}

/** 고수·종목의 가장 최근 이벤트 (놓친 정리 보정용: 마지막 이벤트가 처리된 지 충분히 지났는지 본다) */
export async function latestEventFor(db: D1Database, masterId: number, symbol: Symbol): Promise<{ id: string; kind: CopyEventKind; createdAt: number; processedAt: number | null } | null> {
  const r = await db.prepare('SELECT id, kind, created_at, processed_at FROM copy_events WHERE master_id = ? AND symbol = ? ORDER BY seq DESC LIMIT 1').bind(masterId, symbol).first<{ id: string; kind: string; created_at: number; processed_at: number | null }>();
  return r ? { id: r.id, kind: r.kind as CopyEventKind, createdAt: r.created_at, processedAt: r.processed_at } : null;
}
