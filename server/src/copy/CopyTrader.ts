// 카피 트레이딩: 팔로워 팬아웃 실행 Durable Object (코디네이터 global + shard-N) — docs/copy-trading.md §3
// AutoTrader 와 같은 샤딩. 입력 = copy_events 1건. 팔로워마다 본인 키(실거래) 또는 연습 엔진으로 비례 진입/정리하고 copy_executions 에 남긴다.
// 안전 규칙 (감사 2026-09-18): 주문 전에 실행 행을 선점(pending)해 중복 주문을 막고, 장부는 항상 현재 마스터·현재 모드로만, 실제 포지션과 장부를 매번 맞춘다.
import { DurableObject } from 'cloudflare:workers';
import { estimateLiquidation, priceAtRoi, roundToPrecision, type ContractInfo, type CopyEvent, type Direction, type OpenOrderRequest, type Position, type Price, type Symbol } from '@easy-futures/shared';
import { PaperAdapter } from '../adapters/paper.js';
import type { BrokerAdapter, CloseResult } from '../adapters/types.js';
import { WooxAdapter } from '../adapters/woox.js';
import { humanizeError } from '../auto/AutoTrader.js';
import { getCredsForUser, getSettings } from '../db.js';
import type { Env } from '../env.js';
import { HttpError } from '../errors.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { WooxClient, WooxError } from '../woox/client.js';
import {
  addRealizedPnl, claimCopyExecution, clampCopyPosition, copyClientOrderId, deleteCopyPositions, entryPaused, entryTermsOk, executedFollowerIds, expirePendingExecutions, finishEvent, getActiveFollow, getEvent, getLatestFollow, hasNewerEvent,
  insertCopyExecutions, listActiveFollowers, listAllExpiredPendingExecutions, listCopyPositions, listExpiredPendingExecutions, listUnsettledLiveExecutions, getMasterState, latestEventFor, reduceCopyPosition, setCopyPositionLeverage, setCopyPositionTpSl, snapshotLeftovers, stopFollow, stopFollowsOfUser, updateCopyExecution, upsertCopyPosition,
  type CopyPositionRow, type FollowRow,
} from './db.js';
import { notifyEventFailures, notifyLossLimit, notifyLossLimitPartial, notifyRecovered, notifySwept, notifyUnconfirmed } from './notify.js';
import { entryGuardReason, entrySizing, lossLimitUsed, mergedEntry, REDUCE_CARRY_DETAIL, reduceContracts, roundTripFee, TAKER_FEE } from './sizing.js';
export { ENTRY_MAX_AGE_MS, ENTRY_MAX_DRIFT } from './sizing.js';

// 부분 정리 이월(copy_positions.reduce_carry, 0023) — 장부 행이 없으면 0. 행이 지워진 뒤의 UPDATE 는 0건으로 무해
async function readReduceCarry(db: D1Database, followerId: number, symbol: Symbol): Promise<number> {
  const r = await db.prepare('SELECT reduce_carry AS c FROM copy_positions WHERE follower_id = ? AND symbol = ?').bind(followerId, symbol).first<{ c: number | null }>();
  const c = Number(r?.c);
  return Number.isFinite(c) && c > 0 ? c : 0;
}
async function writeReduceCarry(db: D1Database, followerId: number, symbol: Symbol, carry: number): Promise<void> {
  await db.prepare('UPDATE copy_positions SET reduce_carry = ? WHERE follower_id = ? AND symbol = ?').bind(carry, followerId, symbol).run();
}
import { ENTRY_MAX_AGE_MS as ENTRY_MAX_AGE_MS_LOCAL } from './sizing.js';

export interface CopyRunResult { followers: number; ok: number; fail: number; skipped: number; ms: number; dup?: boolean; superseded?: boolean }

export const copyStub = (env: Env) => env.COPY.get(env.COPY.idFromName('global'));

const MARK_FRESH_MS = 30_000;
const SHARD_SIZE = 3;
const MAX_SHARDS_IN_FLIGHT = 120;
const SHARD_STAGGER_MS = 150;
const MISSED_CLOSE_GRACE_MS = 20_000;   // 고수의 마지막 이벤트가 처리된 지 이만큼 지났는데도 장부가 남아 있으면 '놓친 정리' 로 보고 시장가 정리
const PENDING_TTL_MS = 2 * 60_000;      // 이보다 오래 pending 이면 실행기가 죽은 것 → 결과 불명 실패 (다시 주문하지 않음)
const FOLLOWERS_CACHE_MS = 3_000;
const LOSS_CHECK_CONCURRENCY = 3;   // 손실 점검은 팔로워 3명씩 (전원 직렬도, 전원 동시도 아님 — 감사 A1)
const LIQ_GUARD = 0.002;   // 손절이 강제정리 밖이면 강제정리 0.2% 안쪽으로
const LOSS_LIMIT_DETAIL = '손실 한도 도달 — 멈추고 정리했어요';
const MODE_SWITCH_DETAIL = '모드가 바뀌어 실행하지 않았어요';
const TERMS_DETAIL = '특약 재동의가 필요해 새 진입은 건너뛰었어요';
const OWN_POSITION_DETAIL = '직접 잡은 포지션이 있어 같은 종목은 따라가지 않아요';
const LEVERAGE_REFUSED_DETAIL = '거래소가 열린 포지션의 배율 변경을 막았어요';
const STALE_DETAIL = '시세가 오래돼 실행하지 않았어요 (시세 연결 확인 필요)';
const SUPERSEDED_DETAIL = '더 최신 신호가 있어 건너뛰었어요';
const VANISHED_DETAIL = '실제 포지션이 이미 없어 장부만 정리';
export const LOSS_LIMIT_PARTIAL_DETAIL = '손실 한도 — 일부 정리 실패, 다음 점검에서 재시도';
export const PAUSED_DETAIL = '운영자가 새 진입을 잠시 멈췄어요';
export const NO_SL_CLOSED_DETAIL = '손절을 걸지 못해 바로 정리했어요';
const NO_FILL_RECHECK_MS = 1_500;   // NO_FILL 뒤 계좌를 한 번 더 읽어 뒤늦게 잡힌 체결을 장부에 올린다

type Status = 'ok' | 'failed' | 'skipped';
/** 카피 전용 오류 문구: 일부 정리(PARTIAL_CLOSE)는 남은 수량과 함께 — 장부는 체결된 만큼만 줄고 나머지는 다음 이벤트가 다시 정리한다 */
export function humanizeCopyError(e: unknown): string {
  if (e instanceof HttpError && e.code === 'PARTIAL_CLOSE') {
    const d = (e.detail ?? {}) as { filled?: number; remaining?: number };
    const left = Number(d.remaining);
    return `일부만 정리됨 (${Number.isFinite(left) && left > 0 ? left : '?'}계약 남음) — 다음 이벤트에서 재시도`;
  }
  // 정리 주문은 들어갔는데 결과 확인에 실패(감사 B3): 확인된 체결분만 장부에 반영하고 나머지는 다음 이벤트·점검이 다시 정리
  if (e instanceof HttpError && e.code === 'ORDER_SENT_UNCONFIRMED') return '주문은 접수됐지만 체결 확인에 실패 — 1~2분 안에 거래소 주문 조회로 장부를 맞춰요';
  return humanizeError(e);
}
/** 손실 한도 정리 결과가 전부 끝났는가: ok 이거나 "실제 포지션이 이미 없어" 정산된 것만. 하나라도 실패·미룸이면 장부·팔로우를 남기고 다음 점검에서 재시도 */
export const allBooksSettled = (results: { status: Status; detail: string | null }[]): boolean =>
  results.every((r) => r.status === 'ok' || (r.status === 'skipped' && (r.detail ?? '').startsWith(VANISHED_DETAIL)));
interface ExecResult { status: Status; detail: string | null; orderId: string | null; contracts: number; mode: 'paper' | 'live'; unconfirmed?: boolean; fillPrice?: number | null }   // fillPrice: 팔로워 체결 평균가 (슬리피지 기록, D1 0024)   // unconfirmed: 주문은 나갔는데 결과를 모름 → 행을 pending 으로 남겨 복구가 거래소 조회로 닫는다
interface ShardRequest { eventId: string; followers: FollowRow[]; mark: number; prices: Partial<Record<Symbol, Price>> }
interface Counts { ok: number; fail: number; skipped: number }
type Contracts = Record<Symbol, ContractInfo>;
type Prices = Partial<Record<Symbol, Price>>;
type BookResult = Omit<ExecResult, 'mode'>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
/** 사람이 읽는 가격·금액 (천 단위 쉼표) */
const fmtP = (v: number) => numFmt.format(v);
const fmtPnl = (v: number) => `${v >= 0 ? '+' : ''}${fmtP(r2(v))}`;
const pnlOf = (entry: number, exit: number, contracts: number, contractSize: number, direction: Direction) =>
  r2((exit - entry) * contracts * contractSize * (direction === 'long' ? 1 : -1));
/** 어댑터가 수수료를 못 알려줄 때의 추정: 진입·정리 각각 명목의 0.05% */
const feeEst = (contracts: number, contractSize: number, entry: number, exit: number) => r2(contracts * contractSize * (entry + exit) * TAKER_FEE);
const dirLabel = (d: Direction) => (d === 'long' ? '오른다' : '내린다');
/** 30초 안에 갱신된 마크만 쓴다 (오래된 시세로 손실 한도를 판정하거나 시장가 정리를 하지 않는다) */
export function freshMark(prices: Prices, symbol: Symbol, now = Date.now()): number {
  const p = prices[symbol];
  if (!p || now - p.updatedAt > MARK_FRESH_MS) return 0;
  return p.mark || p.last || 0;
}
/** 손절이 강제정리 밖(또는 같음)이면 강제정리 직전 값으로. 조정됐으면 note */
function guardSl(sl: number, liq: number, direction: Direction, c: ContractInfo): { sl: number; note: string } {
  const outside = direction === 'long' ? sl <= liq : sl >= liq;
  if (!outside) return { sl, note: '' };
  const fixed = roundToPrecision(direction === 'long' ? liq * (1 + LIQ_GUARD) : liq * (1 - LIQ_GUARD), c.pricePrecision);
  return { sl: fixed, note: ` (고수 손절 ${fmtP(sl)}는 내 강제정리 밖이라 ${fmtP(fixed)}로 조정)` };
}
/** 둘 중 더 빡빡한(진입가에 가까운) 손절 */
const slSideOk = (sl: number, mark: number, d: Direction) => (d === 'long' ? sl < mark : sl > mark);
const tpSideOk = (tp: number, mark: number, d: Direction) => (d === 'long' ? tp > mark : tp < mark);
const bookMargin = (b: CopyPositionRow, c: ContractInfo) => (b.contracts * c.contractSize * b.entryPrice) / Math.max(1, b.leverage);
/** 정리 결과의 체결 평균가 (어댑터가 알려줄 때만 — 슬리피지 기록용). 모르면 null */
const closeFillPrice = (res: CloseResult | void): number | null => { const v = Number((res as { avgPrice?: number | null } | void)?.avgPrice); return Number.isFinite(v) && v > 0 ? v : null; };

export class CopyTrader extends DurableObject<Env> {
  private running = new Set<string>();
  /** 종목별로 이벤트를 순서대로 — 진입 팬아웃이 끝나기 전에 정리가 먼저 돌아 "장부 없음"으로 빠지는 경합 방지 */
  private symbolQueue = new Map<string, Promise<unknown>>();
  private followersCache = new Map<number, { at: number; value: Promise<FollowRow[]> }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
    if (url.pathname === '/run') {
      const { eventId, recovery } = (await request.json()) as { eventId: string; recovery?: boolean };
      if (!eventId) return Response.json({ error: 'eventId 필요' }, { status: 400 });
      if (this.running.has(eventId)) return Response.json({ followers: 0, ok: 0, fail: 0, skipped: 0, ms: 0, dup: true } satisfies CopyRunResult);
      this.running.add(eventId);
      try {
        const ev = await getEvent(this.env.DB, eventId);
        const result = await this.enqueue(ev ? [ev.symbol] : ['*'], () => this.runEvent(eventId, !!recovery));
        return Response.json(result);
      } finally { this.running.delete(eventId); }
    }
    if (url.pathname === '/shard') return Response.json(await this.runShard((await request.json()) as ShardRequest));
    if (url.pathname === '/trim-excess') {
      // 관리자: 정리 실패로 쌓인 초과 물량을 고수의 마지막 전량 정리 이후 실제로 따라 들어간 수량까지 줄인다 (새 주문은 정리 주문뿐)
      const { masterId } = (await request.json()) as { masterId: number };
      return Response.json({ ok: true, results: await this.trimExcess(Number(masterId)) });
    }
    if (url.pathname === '/reconcile-event') {
      // 관리자 재확인: 이벤트의 실패·미확인 실거래 행을 거래소 주문 조회로 다시 보고, 체결이 있으면 장부에 올리고 고수의 현재 손절·익절을 맞춘다 (새 주문은 내지 않는다)
      const { eventId } = (await request.json()) as { eventId: string };
      const ev = eventId ? await getEvent(this.env.DB, eventId) : null;
      if (!ev) return Response.json({ error: '이벤트 없음' }, { status: 404 });
      const rows = await listUnsettledLiveExecutions(this.env.DB, ev.id);
      const results = await this.enqueue([ev.symbol], () => this.adoptFromExchange(ev, rows, true));
      return Response.json({ ok: true, eventId: ev.id, results });
    }
    if (url.pathname === '/follower/close') {
      const { followerId } = (await request.json()) as { followerId: number };
      return Response.json(await this.enqueue(['*'], () => this.closeFollower(followerId)));
    }
    if (url.pathname === '/check-loss') {
      const b = (await request.json()) as { followerId?: number; followerIds?: number[] };
      if (Array.isArray(b.followerIds)) return Response.json({ ok: true, results: await this.checkLossMany(b.followerIds) });
      return Response.json(await this.checkLossQueued(Number(b.followerId)));
    }
    if (url.pathname === '/recover-pending') return Response.json(await this.recoverPendingGlobal());
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  /**
   * 손실 점검을 팔로워 단위 작업으로 — 그 팔로워 장부 종목 큐에만 붙인다 ('*' 큐로 모든 고수의 진입·정리를 막지 않는다, 감사 A1).
   * 장부가 없으면 정리할 것이 없으니 큐 없이 바로 (실현손익만으로 한도 판정)
   */
  private async checkLossQueued(followerId: number) {
    const books = await listCopyPositions(this.env.DB, followerId).catch(() => [] as CopyPositionRow[]);
    if (books.length === 0) return this.checkLoss(followerId);
    return this.enqueue([...new Set(books.map((b) => b.symbol as string))], () => this.checkLoss(followerId));
  }
  /** 여러 팔로워를 3명씩 동시에 (풀). 한 명의 실패가 나머지를 막지 않는다 */
  private async checkLossMany(ids: number[]) {
    const out: Record<string, unknown>[] = [];
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        out.push({ followerId: id, ...(await this.checkLossQueued(id).catch((e) => ({ ok: false, reason: (e as Error).message, stopped: false, used: 0 }))) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOSS_CHECK_CONCURRENCY, ids.length) }, worker));
    return out;
  }

  /**
   * 고아 pending 복구 (감사 A5): 샤드가 주문 뒤·기록 전에 죽으면 코디네이터가 이벤트를 processed 로 닫아 runEvent 가 즉시 반환 → 이벤트 단위 복구가 영원히 안 돈다.
   * 이벤트와 무관하게 2분 넘게 pending 인 행을 전역으로 찾아, 실거래는 거래소에서 체결을 되찾아 장부에 올리고 나머지는 결과 불명 실패로 닫는다. 같은 종목 큐에서 실행
   */
  private recoverInflight: Promise<{ ok: true; events: number; expired: number }> | null = null;
  private recoverPendingGlobal(): Promise<{ ok: true; events: number; expired: number }> {
    if (this.recoverInflight) return this.recoverInflight;
    this.recoverInflight = (async () => {
      const db = this.env.DB;
      const rows = await listAllExpiredPendingExecutions(db, PENDING_TTL_MS);
      const eventIds = [...new Set(rows.map((r) => r.eventId))];
      let expired = 0;
      for (const eventId of eventIds) {
        const ev = await getEvent(db, eventId);
        const step = async () => {
          if (ev) await this.recoverExpiredPending(ev).catch((e) => log.error('copy orphan pending recovery failed', { eventId, message: (e as Error).message }));
          const n = await expirePendingExecutions(db, eventId, PENDING_TTL_MS);
          if (n) log.warn('copy orphan pending executions expired', { eventId, expired: n, processed: !!ev?.processedAt });
          expired += n;
        };
        await (ev ? this.enqueue([ev.symbol], step) : step()).catch((e) => log.error('copy orphan pending step failed', { eventId, message: (e as Error).message }));
      }
      return { ok: true as const, events: eventIds.length, expired };
    })().finally(() => { this.recoverInflight = null; });
    return this.recoverInflight;
  }

  /** 종목 큐 뒤에 붙여 실행. '*' 는 모든 종목 큐 뒤 (팔로워 전량 정리처럼 여러 종목을 건드릴 때). 종목 작업은 진행 중인 '*' 작업도 기다린다 */
  private enqueue<T>(symbols: string[], fn: () => Promise<T>): Promise<T> {
    const keys = symbols.includes('*') ? [...new Set(['*', ...this.symbolQueue.keys()])] : symbols;
    const waitOn = symbols.includes('*') ? keys : [...new Set([...keys, '*'])];
    const prevs = waitOn.map((k) => this.symbolQueue.get(k) ?? Promise.resolve());
    const run = Promise.all(prevs.map((p) => p.catch(() => undefined))).then(fn);
    for (const k of keys) this.symbolQueue.set(k, run);
    void run.finally(() => { for (const k of keys) if (this.symbolQueue.get(k) === run) this.symbolQueue.delete(k); }).catch(() => undefined);
    return run;
  }

  private followersOf(masterId: number): Promise<FollowRow[]> {
    const hit = this.followersCache.get(masterId);
    if (hit && Date.now() - hit.at < FOLLOWERS_CACHE_MS) return hit.value;
    const value = listActiveFollowers(this.env.DB, masterId).catch((e) => { this.followersCache.delete(masterId); throw e; });
    this.followersCache.set(masterId, { at: Date.now(), value });
    return value;
  }

  // ---------------- 코디네이터 ----------------
  private async runEvent(eventId: string, recovery: boolean): Promise<CopyRunResult> {
    const env = this.env;
    const t0 = Date.now();
    const ev = await getEvent(env.DB, eventId);
    if (!ev) return { followers: 0, ok: 0, fail: 0, skipped: 0, ms: 0 };
    if (ev.processedAt) return { followers: ev.followerCount ?? 0, ok: ev.okCount ?? 0, fail: ev.failCount ?? 0, skipped: ev.skippedCount ?? 0, ms: 0 };
    // 실행기가 죽어 pending 으로 남은 행은 결과 불명 실패로 닫는다 (다시 주문하지 않는다)
    // 갓 만들어진 이벤트(첫 실행)에는 pending 이 있을 수 없다 — 복구 실행이나 오래된 이벤트에서만 정리 (D1 왕복 1회 절약)
    if (recovery || Date.now() - ev.createdAt > PENDING_TTL_MS) {
      await this.recoverExpiredPending(ev).catch((e) => log.error('copy expired pending recovery failed', { eventId, message: (e as Error).message }));
      const expired = await expirePendingExecutions(env.DB, eventId, PENDING_TTL_MS);
      if (expired) log.warn('copy pending executions expired', { eventId, expired });
    }
    // 시세 DO 가 죽어도 정리(close/reduce)·배율은 시세 없이 진행한다 — 빈 시세로 두면 아래 stale 규칙이 진입·손절만 막는다 (감사 A4)
    const [done, all, pr] = await Promise.all([executedFollowerIds(env.DB, eventId), this.followersOf(ev.masterId), new PaperClient(env).prices().catch((e): { prices: Prices } => { log.error('copy prices unavailable — continuing without mark', { eventId, kind: ev.kind, message: (e as Error).message }); return { prices: {} }; })]);
    const followers = all.filter((f) => !done.has(f.followerId));
    const isEntry = ev.kind === 'open' || ev.kind === 'add';
    const skipAll = async (detail: string, why: string) => {
      await insertCopyExecutions(env.DB, followers.map((f) => ({ eventId, followerId: f.followerId, mode: f.mode, status: 'skipped' as const, detail }))).catch((e) => log.error('copy execution insert failed', e));
      await finishEvent(env.DB, eventId, followers.length + done.size, 0, 0, followers.length);
      log.warn(`copy event skipped: ${why}`, { eventId, kind: ev.kind, symbol: ev.symbol, followers: followers.length });
      return { followers: followers.length, ok: 0, fail: 0, skipped: followers.length, ms: Date.now() - t0 };
    };
    // 유실 복구로 늦게 도는 진입·손절·배율 이벤트는 그 사이 더 최신 이벤트가 있으면 건너뛴다 (정리는 재생해도 안전)
    if (recovery && ev.kind !== 'close' && ev.kind !== 'reduce' && (await hasNewerEvent(env.DB, ev.masterId, ev.symbol, ev.seq))) {
      await insertCopyExecutions(env.DB, followers.map((f) => ({ eventId, followerId: f.followerId, mode: f.mode, status: 'skipped' as const, detail: SUPERSEDED_DETAIL })));
      await finishEvent(env.DB, eventId, followers.length + done.size, 0, 0, followers.length);
      log.warn('copy event superseded', { eventId, kind: ev.kind, symbol: ev.symbol, followers: followers.length });
      return { followers: followers.length, ok: 0, fail: 0, skipped: followers.length, ms: Date.now() - t0, superseded: true };
    }
    const mark = freshMark(pr.prices, ev.symbol);
    log.info('copy event start', { eventId, kind: ev.kind, symbol: ev.symbol, followers: followers.length, alreadyDone: done.size });
    // 시세가 없거나 30초 넘게 오래됐으면 시세가 필요한 일(진입, 손절·익절 방향 검증)은 하지 않는다. 정리(reduce/close)·배율은 시세 없이도 진행
    if (!(mark > 0) && (ev.kind === 'open' || ev.kind === 'add' || ev.kind === 'tpsl')) {
      await insertCopyExecutions(env.DB, followers.map((f) => ({ eventId, followerId: f.followerId, mode: f.mode, status: 'failed' as const, detail: STALE_DETAIL }))).catch((e) => log.error('copy execution insert failed', e));
      await finishEvent(env.DB, eventId, followers.length + done.size, 0, followers.length, 0);
      log.error('copy event aborted: stale mark', { eventId, symbol: ev.symbol, updatedAt: pr.prices[ev.symbol]?.updatedAt ?? null });
      return { followers: followers.length, ok: 0, fail: followers.length, skipped: 0, ms: Date.now() - t0 };
    }
    if (isEntry && followers.length > 0) {
      // 킬 스위치: 운영자가 (전체 또는 이 고수의) 새 진입을 멈췄으면 open/add 만 건너뛴다 — 정리·손절·배율·손실 한도는 그대로
      const pause = await entryPaused(env.DB, ev.masterId);
      if (pause.paused) return skipAll(PAUSED_DETAIL, pause.global ? 'paused (global)' : 'paused (master)');
      // 진입 가드: 신호가 오래됐거나(>10초) 고수 체결가에서 0.5% 넘게 움직였으면 진입하지 않는다
      const guard = entryGuardReason(ev.createdAt, ev.price, mark);
      if (guard) return skipAll(guard, 'entry guard');
    }
    const shards: ShardRequest[] = [];
    for (let i = 0; i < followers.length; i += SHARD_SIZE) shards.push({ eventId, followers: followers.slice(i, i + SHARD_SIZE), mark, prices: pr.prices });
    const totals: Counts = { ok: 0, fail: 0, skipped: 0 };
    for (let i = 0; i < shards.length; i += MAX_SHARDS_IN_FLIGHT) {
      const batch = shards.slice(i, i + MAX_SHARDS_IN_FLIGHT);
      const results = await Promise.all(batch.map(async (sh, k) => {
        if (k > 0) await new Promise((res) => setTimeout(res, k * SHARD_STAGGER_MS));   // 샤드 시작을 조금씩 어긋나게 — 같은 IP 에서 REST 가 한꺼번에 몰려 429 가 나지 않게
        const stub = env.COPY.get(env.COPY.idFromName(`shard-${i + k}`));
        try {
          const r = await stub.fetch('https://copy/shard', { method: 'POST', body: JSON.stringify(sh), headers: { 'content-type': 'application/json' } });
          if (r.status === 404) return this.runShard(sh);
          if (!r.ok) throw new Error(`shard http ${r.status}`);
          return (await r.json()) as Counts;
        } catch (e) {
          log.error('copy shard failed', e);
          // 샤드 호출 자체가 실패: 선점 안 된 팔로워만 실패로 기록 (선점된 행은 pending 만료 규칙이 닫는다)
          await insertCopyExecutions(env.DB, sh.followers.map((f) => ({ eventId, followerId: f.followerId, mode: f.mode, status: 'failed' as const, detail: '실행기 오류 — 담당자에게 문의하세요' }))).catch((err) => log.error('copy execution insert failed', err));
          return { ok: 0, fail: sh.followers.length, skipped: 0 };
        }
      }));
      for (const c of results) { totals.ok += c.ok; totals.fail += c.fail; totals.skipped += c.skipped; }
    }
    await finishEvent(env.DB, eventId, followers.length + done.size, totals.ok, totals.fail, totals.skipped);
    if (totals.fail > 0) this.ctx.waitUntil(notifyEventFailures(env, ev, totals.fail, followers.length));   // 관리자 텔레그램 (10분 중복 제거, 절대 던지지 않음)
    const ms = Date.now() - t0;
    log.info('copy event done', { eventId, ...totals, followers: followers.length, ms, shards: shards.length });
    return { followers: followers.length, ...totals, ms };
  }

  // ---------------- 샤드 ----------------
  private async runShard(req: ShardRequest): Promise<Counts> {
    const env = this.env;
    const ev = await getEvent(env.DB, req.eventId);
    if (!ev) return { ok: 0, fail: req.followers.length, skipped: 0 };
    const paper = new PaperClient(env);
    const contracts = await getContracts();
    const counts: Counts = { ok: 0, fail: 0, skipped: 0 };
    // 손절·익절·배율 변경은 팔로워당 REST 6~7회라 10명이 동시에 돌면 같은 IP 에서 초당 60회를 넘겨 429 가 난다(2026-09-22 23:28 실측: 6/10 실패).
    // 진입·정리는 속도가 중요하니 병렬 유지, 변경 신호는 샤드 안에서 순차 (샤드 4개 병렬 → 동시 4명)
    const sequential = ev.kind === 'tpsl' || ev.kind === 'leverage';
    const runOne = async (f: FollowRow) => {
      // 주문 전에 선점 — 같은 이벤트·팔로워가 두 실행기에서 동시에 돌지 않는다
      if (!(await claimCopyExecution(env.DB, req.eventId, f.followerId, f.mode, copyClientOrderId(ev.masterId, ev.seq, f.followerId)))) { log.warn('copy execution already claimed', { eventId: req.eventId, followerId: f.followerId }); return; }
      const seen = { mode: f.mode };
      const run = () => this.executeFor(f, ev, req.mark, req.prices, contracts, paper, (m) => { seen.mode = m; });
      // 거래소 429(요청 과다)·네트워크 오류: 주문 전 단계에서만 나는 오류라 다시 시도해도 중복 주문이 없다 (주문 뒤 오류는 ORDER_SENT_UNCONFIRMED 로 구분됨).
      // 진입은 10초 신선도 안에서 1회, 정리·손절·배율은 최대 3회 (정리를 놓치는 게 가장 위험)
      const isEntry = ev.kind === 'open' || ev.kind === 'add';
      const retryable = (e: unknown) => e instanceof WooxError && (e.httpStatus === 429 || e.code === 'NETWORK' || e.httpStatus >= 500);
      const runWithRetry = async (): Promise<ExecResult> => {
        const maxRetries = isEntry ? 2 : 3;   // 진입도 10초 신선도 안에서 2회까지 (키 창 2초가 지나면 통과한다)
        for (let attempt = 0; ; attempt++) {
          try { return await run(); }
          catch (e) {
            if (attempt >= maxRetries || !retryable(e)) throw e;
            const wait = Math.min(4000, Math.max(1000, (e as WooxError).retryAfterMs ?? 1000 * (attempt + 1))) + Math.floor(Math.random() * 1000);   // 무작위 지연으로 팔로워들의 재시도가 같은 순간에 몰리지 않게
            if (isEntry && Date.now() - ev.createdAt + wait >= ENTRY_MAX_AGE_MS_LOCAL) throw e;
            log.warn('copy execution retry after exchange error', { eventId: req.eventId, followerId: f.followerId, attempt: attempt + 1, wait, message: (e as Error).message });
            await new Promise((res) => setTimeout(res, wait));
          }
        }
      };
      const r: ExecResult = await runWithRetry().catch((e) => {
        log.warn('copy execution failed', { eventId: req.eventId, followerId: f.followerId, message: (e as Error).message });
        const unconfirmed = e instanceof HttpError && e.code === 'ORDER_SENT_UNCONFIRMED';
        const orderId = unconfirmed ? String((e.detail as { orderId?: string } | undefined)?.orderId ?? '') || null : null;
        return { status: 'failed' as const, detail: humanizeCopyError(e), orderId, contracts: 0, mode: seen.mode, unconfirmed };
      });
      if (r.status === 'ok') counts.ok++; else if (r.status === 'failed') counts.fail++; else counts.skipped++;
      // 주문이 나갔는데 결과를 모르면 pending 으로 남긴다 — 60초 복구가 거래소 주문 조회로 체결을 장부에 올리거나 2분 뒤 결과 불명으로 닫는다 (고아 포지션 방지)
      const rowStatus = r.unconfirmed && r.mode === 'live' ? 'pending' : r.status;
      await updateCopyExecution(env.DB, req.eventId, f.followerId, r.mode, rowStatus, r.detail, r.orderId, r.contracts, r.fillPrice ?? null).catch((err) => log.error('copy execution update failed', { eventId: req.eventId, followerId: f.followerId, message: (err as Error).message }));
      if (rowStatus === 'pending') this.ctx.waitUntil(notifyUnconfirmed(env, ev, f.followerId, r.orderId));
      // 실거래 키 없음/거절이면 팔로우를 멈춘다 — 이벤트마다 같은 실패가 반복되지 않게
      if (r.mode === 'live' && ((r.status === 'skipped' && r.detail === 'API 키 없음') || (r.status === 'failed' && /API 키가 거절/.test(r.detail ?? '')))) {
        await stopFollowsOfUser(env.DB, f.followerId, 'no_api_key').catch(() => {});
      }
    };
    if (sequential) { for (const f of req.followers) await runOne(f); }
    else await Promise.all(req.followers.map(runOne));
    return counts;
  }

  private async adapterFor(userId: number, paper: PaperClient): Promise<{ mode: 'paper' | 'live'; adapter: BrokerAdapter | null; appMaxLeverage: number }> {
    const [settings, creds] = await Promise.all([getSettings(this.env, userId), getCredsForUser(this.env, userId)]);   // 병렬 (둘 다 격리환경 캐시)
    if (settings.mode === 'live') {
      return { mode: 'live', adapter: creds ? new WooxAdapter(new WooxClient({ credentials: creds, gate: makeRateGate(this.env) })) : null, appMaxLeverage: settings.maxLeverage };
    }
    return { mode: 'paper', adapter: new PaperAdapter(paper, userId), appMaxLeverage: settings.maxLeverage };
  }

  private async executeFor(cached: FollowRow, ev: CopyEvent, mark: number, prices: Prices, contracts: Contracts, paper: PaperClient, onMode: (m: 'paper' | 'live') => void): Promise<ExecResult> {
    const env = this.env;
    // 팔로우 행은 방금 읽는다 (팬아웃 목록은 3초 캐시 — 실현손익·설정·정지 여부는 최신이어야 한다)
    const [{ mode, adapter, appMaxLeverage }, fresh] = await Promise.all([this.adapterFor(cached.followerId, paper), getActiveFollow(env.DB, cached.followerId)]);
    onMode(mode);
    if (!fresh || fresh.id !== cached.id) return { status: 'skipped', detail: '따라하기가 멈춰 실행하지 않았어요', orderId: null, contracts: 0, mode };
    const f: FollowRow = { ...fresh, userTermsVersion: cached.userTermsVersion };
    // 팔로우를 시작한 모드로만 실행한다 — 실거래 팔로우가 연습 엔진으로(또는 반대로) 흘러가지 않게
    if (mode !== f.mode) return { status: 'skipped', detail: MODE_SWITCH_DETAIL, orderId: null, contracts: 0, mode };
    if (!adapter) return { status: 'skipped', detail: 'API 키 없음', orderId: null, contracts: 0, mode };
    const contract = contracts[ev.symbol];
    // 실제 계좌를 한 번 읽고: (1) 사라진 장부는 정산, (2) 손실 한도, (3) 이벤트 실행 — 모두 이 스냅샷으로
    const [acc, rawBooks] = await Promise.all([adapter.getAccount(contracts, prices), listCopyPositions(env.DB, f.followerId, f.masterId)]);
    const books = await this.reconcileBooks(f, adapter, rawBooks, acc.positions, prices, contracts);
    // 손실 한도: 실행 전에 실현 + 장부 미실현(신선한 시세만)으로 확인. 넘었으면 장부 전량 정리 + 팔로우 정지
    if (lossLimitUsed(f.settings.copyAmount, f.settings.lossLimitPct, f.realizedPnl, unrealizedOf(books, prices, contracts)) >= 1) {
      const results = await this.closeBooks(f, adapter, books, prices, contracts, acc.positions, true, `cp${ev.masterId}L${f.followerId}t${Date.now().toString(36)}`);
      // 전부 정리됐을 때만 멈춘다. 하나라도 실패·미룸이면 장부와 팔로우를 남기고 다음 점검(15초)에서 다시 정리
      if (!allBooksSettled(results)) { log.warn('copy loss limit: partial close, retry next check', { followerId: f.followerId, results }); this.ctx.waitUntil(this.noteLossLimitPartial(f, results)); return { status: 'skipped', detail: LOSS_LIMIT_PARTIAL_DETAIL, orderId: null, contracts: 0, mode }; }
      await stopFollow(env.DB, f.id, 'loss_limit');
      await deleteCopyPositions(env.DB, f.followerId);
      this.ctx.waitUntil(notifyLossLimit(env, f, results));
      return { status: 'skipped', detail: LOSS_LIMIT_DETAIL, orderId: null, contracts: 0, mode };
    }
    const book = books.find((b) => b.symbol === ev.symbol) ?? null;
    const real = acc.positions.find((p) => p.symbol === ev.symbol) ?? null;
    const clientOrderId = copyClientOrderId(ev.masterId, ev.seq, f.followerId);
    if (ev.kind === 'reduce' || ev.kind === 'close') {
      if (!book) return { status: 'skipped', detail: '따라 들어간 포지션 없음', orderId: null, contracts: 0, mode };
      // reduce: 정확한 비례 수량(장부 × 비율 + 이월)을 정수 계약으로 내림, 1계약 미만 나머지는 장부에 이월 (docs/copy-trading.md '부분 정리 이월')
      const carry = ev.kind === 'reduce' ? await readReduceCarry(env.DB, f.followerId, ev.symbol) : 0;
      const rc = ev.kind === 'close' ? { contracts: book.contracts, carry: 0 } : reduceContracts(ev.beforeContracts, ev.afterContracts, book.contracts, carry);
      if (rc.contracts <= 0) {
        if (ev.kind === 'reduce' && rc.carry !== carry) await writeReduceCarry(env.DB, f.followerId, ev.symbol, rc.carry);
        return { status: 'skipped', detail: ev.kind === 'reduce' && rc.carry > 0 ? REDUCE_CARRY_DETAIL(rc.carry) : '정리할 수량 없음', orderId: null, contracts: 0, mode };
      }
      const r = await this.closeBook(f, adapter, book, rc.contracts, freshMark(prices, ev.symbol) || mark, contract, real, prices, contracts, clientOrderId);
      // 정리가 끝났을 때만 이월을 갱신한다 (행이 지워졌으면 UPDATE 는 0건 — 전량 정리는 이월 무관). 실패·일부 체결이면 예전 이월 유지
      if (ev.kind === 'reduce' && r.status === 'ok' && rc.carry !== carry) await writeReduceCarry(env.DB, f.followerId, ev.symbol, rc.carry);
      return { ...r, mode };
    }
    if (ev.kind === 'tpsl' || ev.kind === 'leverage') {
      if (!book) return { status: 'skipped', detail: '따라 들어간 포지션 없음', orderId: null, contracts: 0, mode };
      if (!real || real.direction !== book.direction) return { ...(await this.settleVanished(f, adapter, book, prices, contracts)), mode };
      const r = ev.kind === 'tpsl' ? await this.mirrorTpSl(f, book, ev, mark, contract, real, adapter) : await this.mirrorLeverage(f, book, ev, appMaxLeverage, contract, real, adapter);
      return { ...r, mode };
    }
    // open / add
    if (!(mark > 0)) return { status: 'failed', detail: '시세 없음', orderId: null, contracts: 0, mode };
    const direction = ev.direction;
    if (real && real.direction !== direction) return { status: 'skipped', detail: '반대 방향 포지션 보유 중', orderId: null, contracts: 0, mode };
    const old = book && book.direction === direction ? book : null;
    // 고수는 0 에서 새로 진입(open)인데 내 장부가 남아 있다 = 직전 정리가 실패한 물량. 그 위에 겹쳐 들어가면 노출이 2~4배로 쌓인다(2026-10-02 13:27·13:30 실측).
    // 먼저 남은 장부를 정리하고 이번 진입은 건너뛴다 (잔고·포지션이 방금 바뀌어 크기 계산을 다시 해야 한다 — 다음 신호부터 정상). 정리도 안 되면 진입하지 않는다
    if (ev.kind === 'open' && ev.beforeContracts === 0 && book && real) {
      const cr = await this.closeBook(f, adapter, book, book.contracts, mark, contract, real, prices, contracts, `${clientOrderId}z`.slice(0, 32)).catch((e) => ({ status: 'failed' as const, detail: humanizeCopyError(e), orderId: null, contracts: 0 }));
      log.warn('copy stale book at fresh open — closed instead of stacking', { followerId: f.followerId, symbol: ev.symbol, book: book.contracts, result: cr.status, detail: cr.detail });
      if (cr.status !== 'ok') return { status: 'failed', detail: `이전 포지션 정리 실패로 겹쳐 진입하지 않았어요 (${cr.detail ?? ''})`.slice(0, 200), orderId: null, contracts: 0, mode };
      return { status: 'skipped', detail: `정리 못 했던 이전 포지션을 정리했어요 — 이번 진입은 건너뜀 (${cr.detail ?? ''})`.slice(0, 200), orderId: null, contracts: 0, mode };
    }
    // 같은 방향인데 장부로 설명되지 않는 물량(직접 잡은 것)이 있으면 손절이 섞이므로 따라가지 않는다
    if (real && real.contracts > (old?.contracts ?? 0) + 1e-9) return { status: 'skipped', detail: OWN_POSITION_DETAIL, orderId: null, contracts: 0, mode };
    if (!entryTermsOk(f)) return { status: 'skipped', detail: TERMS_DETAIL, orderId: null, contracts: 0, mode };
    // 총 노출 상한: 따라갈 돈 − 이미 들어간 장부 증거금
    const used = books.reduce((a, b) => a + bookMargin(b, contracts[b.symbol]), 0);
    const available = Math.max(0, Math.min(acc.wallet.available, f.copyAmountNow - used));
    const sizing = entrySizing({
      masterDelta: ev.afterContracts - ev.beforeContracts, price: ev.price > 0 ? ev.price : mark, masterLeverage: ev.leverage, masterEquity: ev.masterEquity,
      copyAmountNow: f.copyAmountNow, available, followerMaxLeverage: Math.min(f.settings.maxLeverage, appMaxLeverage), contract,
      fixedLeverage: real && real.leverage > 0 ? Math.max(1, Math.round(real.leverage)) : old ? old.leverage : undefined,   // 불타기는 실제 포지션의 배율 그대로 (거래소 규칙: 열린 포지션이 있으면 그 배율로만 주문 가능). 실제를 못 읽으면 장부 값
    });
    if (sizing.contracts <= 0) return { status: 'skipped', detail: sizing.reason ?? '금액이 너무 적음', orderId: null, contracts: 0, mode };
    const leverage = sizing.leverage;
    // 손절: 고수 손절가(마크를 지나지 않았을 때)와 내 돈 기준 slRoi 중 더 빡빡한 쪽. 강제정리 밖이면 직전 값으로 조정. 익절은 고수 것 그대로(선택)
    const masterSl = ev.slPrice != null && ev.slPrice > 0 && slSideOk(ev.slPrice, mark, direction) ? roundToPrecision(ev.slPrice, contract.pricePrecision) : null;
    const ownSl = roundToPrecision(priceAtRoi(mark, f.settings.slRoi, leverage, direction, 'sl'), contract.pricePrecision);
    const rawSl = masterSl == null ? ownSl : masterSl;   // 고수와 동일 (2026-09-18 사용자 결정: 손절·익절 설정은 고수를 그대로 따른다). 고수 손절이 없을 때만 내 % 로 진입
    const ownTighter = false;
    const g = guardSl(rawSl, estimateLiquidation(old ? mergedEntry(old.contracts, old.entryPrice, sizing.contracts, mark) : mark, leverage, direction), direction, contract);   // 불타기는 합쳐진 평단 기준 강제정리가 (현재가 기준으로 재면 손절이 강제정리 밖에 놓인다)
    const sl = g.sl;
    const slNote = g.note
      || (masterSl == null && ev.slPrice != null ? ` (고수 손절 ${fmtP(ev.slPrice)}는 지금 가격을 지나쳐 내 돈 기준 -${f.settings.slRoi}% 적용)`
        : masterSl == null ? ` (고수 손절 없음 → 내 돈 기준 -${f.settings.slRoi}%)`
          : ownTighter ? ` (고수 손절 ${fmtP(masterSl)}보다 내 손절 한도 -${f.settings.slRoi}%가 더 빡빡해 그 값 적용)` : '');
    const tp = ev.tpPrice != null && ev.tpPrice > 0 && tpSideOk(ev.tpPrice, mark, direction) ? roundToPrecision(ev.tpPrice, contract.pricePrecision) : null;
    const req: OpenOrderRequest = { symbol: ev.symbol, direction, amountUsdt: sizing.marginUsdt, leverage, stopLossPrice: sl, takeProfitPrice: tp, stopLossRoiPct: masterSl == null && !g.note ? f.settings.slRoi : null, takeProfitRoiPct: null };
    // 주문 직전 재확인: 그 사이 멈춘 팔로우(해지·관리자·손실 한도)면 주문하지 않는다
    const still = await getActiveFollow(env.DB, f.followerId);
    if (!still || still.id !== f.id) return { status: 'skipped', detail: '따라하기가 멈춰 실행하지 않았어요', orderId: null, contracts: 0, mode };
    let r: Awaited<ReturnType<BrokerAdapter['openOrder']>>;
    let adoptNote = '';
    try {
      r = await adapter.openOrder(req, sizing.contracts, contract, mark, { clientOrderId });
    } catch (e) {
      // NO_FILL 오탐 방어: 1.5초 뒤 계좌를 다시 읽어 장부로 설명되지 않는 같은 방향 물량이 생겼으면 그 체결을 장부에 올린다
      if (!(e instanceof HttpError && e.code === 'NO_FILL')) throw e;
      await new Promise((res) => setTimeout(res, NO_FILL_RECHECK_MS));
      const again = (await adapter.getAccount(contracts, prices)).positions.find((p) => p.symbol === ev.symbol && p.direction === direction);
      const extra = again ? Math.round(again.contracts - (old?.contracts ?? 0)) : 0;
      if (!(extra > 0)) throw e;
      log.warn('copy NO_FILL but position grew — adopting into book', { followerId: f.followerId, symbol: ev.symbol, extra });
      r = { orderId: String((e.detail as { orderId?: string } | undefined)?.orderId ?? ''), contracts: extra, coinAmount: extra * contract.contractSize, entryPrice: again!.entryPrice, fillPrice: null, stopLossPrice: again!.stopLossPrice ?? sl, takeProfitPrice: again!.takeProfitPrice ?? tp };
      adoptNote = ' (체결 확인이 늦어 계좌에서 확인한 수량을 장부에 올림)';
    }
    const got = r.contracts > 0 ? Math.round(r.contracts) : sizing.contracts;   // 장부 = 실제 체결 수량
    const fillPrice = r.fillPrice && r.fillPrice > 0 ? r.fillPrice : r.entryPrice && r.entryPrice > 0 ? r.entryPrice : mark;
    // 장부 평단: 실거래 불타기는 거래소 포지션 평단을 그대로(이중 평균 금지), 그 밖엔 이번 체결가로 합산
    const entryPrice = mode === 'live' && old && r.entryPrice && r.entryPrice > 0 ? r.entryPrice : mergedEntry(old?.contracts ?? 0, old?.entryPrice ?? fillPrice, got, fillPrice);
    const slFinal = r.stopLossPrice ?? sl;
    await upsertCopyPosition(env.DB, {
      followerId: f.followerId, masterId: ev.masterId, symbol: ev.symbol, direction, contracts: (old?.contracts ?? 0) + got,
      entryPrice, leverage, openedAt: old?.openedAt, slPrice: slFinal, tpPrice: r.takeProfitPrice ?? tp,
    });
    await writeReduceCarry(env.DB, f.followerId, ev.symbol, 0);   // 신규·추가 진입은 부분 정리 이월을 0 으로 (비율의 기준 장부가 바뀌었다)
    // 실거래: 진입 뒤 손절 플랜 주문이 실제로 걸려 있는지 확인. 없으면 걸고, 그것도 안 되면 방금 들어간 수량을 바로 정리한다 (손절 없는 포지션을 남기지 않는다)
    let slVerifyNote = '';
    if (mode === 'live' && adapter.hasStopLoss) {
      let has: boolean | null = null;
      for (let i = 0; i < 2 && has === null; i++) has = await adapter.hasStopLoss(ev.symbol).catch((err) => { log.warn('copy sl verify failed', { followerId: f.followerId, attempt: i, message: (err as Error).message }); return null; });
      if (has === null) slVerifyNote = ' (손절 확인 실패 — 다음 점검에서 확인)';
      else if (!has) {
        try { await adapter.updateTpSl({ symbol: ev.symbol, stopLossPrice: slFinal }, contract); slVerifyNote = ' (손절이 빠져 있어 다시 걸었어요)'; }
        catch (err) {
          log.error('copy sl missing and resubmit failed — closing just-opened quantity', { followerId: f.followerId, symbol: ev.symbol, got, message: (err as Error).message });
          const closed = await adapter.reducePosition(ev.symbol, got, contract, { clientOrderId: `${clientOrderId}x` }).catch((e2) => { log.error('copy emergency close failed', { followerId: f.followerId, message: (e2 as Error).message }); return undefined; });
          const doneQty = closed && closed.contracts > 0 ? Math.min(closed.contracts, got) : closed === undefined ? 0 : got;
          if (doneQty > 0) await reduceCopyPosition(env.DB, f.followerId, ev.symbol, doneQty);
          return { status: 'failed', detail: `${NO_SL_CLOSED_DETAIL}${doneQty < got ? ` (${got - doneQty}계약은 정리 실패 — 직접 확인하세요)` : ''}`, orderId: r.orderId, contracts: got, mode };
        }
      }
    }
    const label = ev.kind === 'add' ? (old ? '추가 진입 ' : '신규 진입(추가 신호) ') : '';
    const capNote = sizing.cappedByAvailable ? ' (쓸 수 있는 돈만큼 줄임)' : '';
    const fillNote = got !== sizing.contracts ? ` (요청 ${sizing.contracts}계약 중 ${got}계약 체결)` : '';
    return { status: 'ok', detail: `${label}${dirLabel(direction)} ${fmtP(sizing.marginUsdt)} USDT ${leverage}배 (${got}계약) · 손절 ${fmtP(slFinal)}${tp ? ` · 익절 ${fmtP(r.takeProfitPrice ?? tp)}` : ''}${slNote}${capNote}${fillNote}${adoptNote}${slVerifyNote}`, orderId: r.orderId, contracts: got, mode, fillPrice: r.fillPrice && r.fillPrice > 0 ? r.fillPrice : !old && r.entryPrice && r.entryPrice > 0 ? r.entryPrice : null };
  }

  /**
   * 실행기가 죽어 2분 넘게 pending 인 open/add 행: 주문은 나갔을 수 있다 → 실거래 팔로워는 client_order_id 로 거래소에 체결 여부를 묻고,
   * 체결됐으면 장부에 올리고 ok 로 닫는다 (결과 불명으로 버리지 않는다). 못 찾거나 미체결이면 그대로 두고 호출자가 expirePendingExecutions 로 닫는다
   */
  private async recoverExpiredPending(ev: CopyEvent): Promise<void> {
    if (ev.kind !== 'open' && ev.kind !== 'add') return;
    const rows = await listExpiredPendingExecutions(this.env.DB, ev.id, PENDING_TTL_MS);
    if (rows.length === 0) return;
    await this.adoptFromExchange(ev, rows, false);
  }

  /**
   * 거래소 주문 조회(client_order_id)로 실제 체결을 찾아 장부에 올린다. 새 주문은 내지 않는다.
   * applyMasterTpSl 이면(관리자 재확인) 편입 뒤 고수의 현재 손절·익절을 그 포지션에 맞춘다 — 편입 전에 나간 손절 변경 신호를 놓쳤을 수 있어서
   */
  private async adoptFromExchange(ev: CopyEvent, rows: { followerId: number; mode: 'paper' | 'live'; clientOrderId: string | null; status?: string }[], applyMasterTpSl: boolean): Promise<{ followerId: number; result: string; qty?: number }[]> {
    const env = this.env;
    const out: { followerId: number; result: string; qty?: number }[] = [];
    if (ev.kind !== 'open' && ev.kind !== 'add') return rows.map((r) => ({ followerId: r.followerId, result: '진입 이벤트가 아님' }));
    if (rows.length === 0) return out;
    const paper = new PaperClient(env);
    const [contracts, pr] = await Promise.all([getContracts(), paper.prices().catch(() => ({ prices: {} as Partial<Record<Symbol, Price>> }))]);
    const masterState = applyMasterTpSl ? await getMasterState(env.DB, ev.masterId).catch(() => null) : null;
    for (const row of rows) {
      if (row.mode !== 'live' || !row.clientOrderId) { out.push({ followerId: row.followerId, result: '조회 대상 아님' }); continue; }
      try {
        const { adapter, mode } = await this.adapterFor(row.followerId, paper);
        if (!adapter || mode !== 'live' || !adapter.findFill) { out.push({ followerId: row.followerId, result: 'API 키 없음' }); continue; }
        const fill = await adapter.findFill(ev.symbol, row.clientOrderId);
        if (!fill || !(fill.dealSize > 0)) { out.push({ followerId: row.followerId, result: '거래소에 체결 없음 (주문이 나가지 않았거나 체결 0)' }); continue; }
        const real = (await adapter.getAccount(contracts, pr.prices)).positions.find((p) => p.symbol === ev.symbol && p.direction === ev.direction) ?? null;
        const follow = await getActiveFollow(env.DB, row.followerId);
        const book = (await listCopyPositions(env.DB, row.followerId, ev.masterId)).find((b) => b.symbol === ev.symbol && b.direction === ev.direction) ?? null;
        const qty = Math.round(real ? Math.min(fill.dealSize, Math.max(0, real.contracts - (book?.contracts ?? 0))) : fill.dealSize);
        if (!(qty > 0) || !follow) {
          log.warn('copy adopt: fill found but nothing to adopt', { eventId: ev.id, followerId: row.followerId, dealSize: fill.dealSize, real: real?.contracts ?? 0, book: book?.contracts ?? 0 });
          out.push({ followerId: row.followerId, result: !follow ? '따라하기가 멈춰 있음' : real ? `이미 장부에 있음 (실제 ${real.contracts}계약 · 장부 ${book?.contracts ?? 0}계약)` : '체결은 있었으나 지금 포지션 없음 (이미 정리됨)' });
          continue;
        }
        const price = fill.dealAvgPrice ?? real?.entryPrice ?? ev.price;
        await upsertCopyPosition(env.DB, {
          followerId: row.followerId, masterId: ev.masterId, symbol: ev.symbol, direction: ev.direction, contracts: (book?.contracts ?? 0) + qty,
          entryPrice: book && real && real.entryPrice > 0 ? real.entryPrice : mergedEntry(book?.contracts ?? 0, book?.entryPrice ?? price, qty, price),
          leverage: book?.leverage ?? (real ? Math.max(1, Math.round(real.leverage)) : Math.max(1, Math.floor(ev.leverage || 1))), openedAt: book?.openedAt,
          slPrice: real?.stopLossPrice ?? ev.slPrice ?? null, tpPrice: real?.takeProfitPrice ?? ev.tpPrice ?? null,
        });
        let note = '';
        // 편입 뒤 고수의 지금 손절·익절로 맞춘다 (편입 전 손절 변경 신호를 놓쳤을 수 있음)
        const ms = masterState?.get(ev.symbol);
        if (ms && ms.direction === ev.direction && ms.contracts > 0 && real) {
          const wantSl = ms.slPrice ?? null, wantTp = ms.tpPrice ?? null;
          const diff = (a: number | null, b: number | null) => (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > 1e-9);
          if (diff(wantSl, real.stopLossPrice ?? null) || diff(wantTp, real.takeProfitPrice ?? null)) {
            try {
              await adapter.updateTpSl({ symbol: ev.symbol, stopLossPrice: wantSl, takeProfitPrice: wantTp }, contracts[ev.symbol]);
              await setCopyPositionTpSl(env.DB, row.followerId, ev.symbol, wantSl, wantTp).catch(() => {});
              note = ` · 손절 ${wantSl == null ? '해제' : fmtP(wantSl)}${wantTp != null ? ` 익절 ${fmtP(wantTp)}` : ''} 로 고수와 맞춤`;
            } catch (e) { note = ` · 손절 맞추기 실패: ${(e as Error).message}`; log.warn('copy adopt tpsl sync failed', { eventId: ev.id, followerId: row.followerId, message: (e as Error).message }); }
          }
        }
        await updateCopyExecution(env.DB, ev.id, row.followerId, 'live', 'ok', `${dirLabel(ev.direction)} ${qty}계약 (실행 결과를 늦게 확인 — 거래소 주문 조회로 장부에 올림${note})`, fill.orderId ?? null, qty);   // 주문 id 를 남겨야 거래 내역 출처가 '고수 따라하기' 로 잡힌다
        log.warn('copy pending/failed execution recovered from exchange', { eventId: ev.id, followerId: row.followerId, qty, note });
        this.ctx.waitUntil(notifyRecovered(env, ev, row.followerId, qty, note));
        out.push({ followerId: row.followerId, result: `편입 ${qty}계약${note}`, qty });
      } catch (e) {
        log.warn('copy adopt lookup failed', { eventId: ev.id, followerId: row.followerId, message: (e as Error).message });
        out.push({ followerId: row.followerId, result: `조회 실패: ${(e as Error).message}` });
      }
    }
    return out;
  }

  /** 장부와 실제 계좌 맞추기: 실제 포지션이 없거나 방향이 다른 장부(손절·익절·강제정리로 이미 끝남)는 실현손익을 반영하고 지운다 */
  private async reconcileBooks(f: FollowRow, adapter: BrokerAdapter, books: CopyPositionRow[], positions: Position[], prices: Prices, contracts: Contracts): Promise<CopyPositionRow[]> {
    const alive: CopyPositionRow[] = [];
    for (const b of books) {
      const real = positions.find((p) => p.symbol === b.symbol);
      if (real && real.direction === b.direction) {
        // 실제가 장부보다 작으면(직접 일부 정리) 장부를 실제 수량으로 줄인다 — 장부가 실제보다 큰 채로 정리·손실 판정을 하지 않는다
        if (real.contracts + 1e-9 < b.contracts) {
          const left = await clampCopyPosition(this.env.DB, f.followerId, b.symbol, real.contracts).catch((e) => { log.warn('copy book clamp failed', { followerId: f.followerId, symbol: b.symbol, message: (e as Error).message }); return b.contracts; });
          log.info('copy book clamped to real position', { followerId: f.followerId, symbol: b.symbol, book: b.contracts, real: real.contracts });
          if (left > 0) alive.push({ ...b, contracts: left });
          continue;
        }
        // 배율은 거래소가 진실 — 팔로워가 우엑스에서 직접 바꿨거나 우리 배율 변경이 늦게 반영됐으면 장부를 실제 값으로 맞춘다 (다음 추가 진입이 잘못된 배율로 거절되지 않게)
        const realLev = Math.max(1, Math.round(real.leverage));
        if (real.leverage > 0 && realLev !== b.leverage) {
          await setCopyPositionLeverage(this.env.DB, f.followerId, b.symbol, realLev).catch((e) => log.warn('copy book leverage sync failed', { followerId: f.followerId, symbol: b.symbol, message: (e as Error).message }));
          log.info('copy book leverage synced to real position', { followerId: f.followerId, symbol: b.symbol, book: b.leverage, real: realLev });
          alive.push({ ...b, leverage: realLev }); continue;
        }
        alive.push(b); continue;
      }
      await this.settleVanished(f, adapter, b, prices, contracts).catch((e) => log.warn('copy book settle failed', { followerId: f.followerId, symbol: b.symbol, message: (e as Error).message }));
    }
    return alive;
  }

  /**
   * 실제 포지션이 이미 없는 장부 정산: 거래 내역(하루)에서 이 종목·방향의 정리 체결(손절·익절·강제정리·직접 정리)을 최신순으로 장부 수량만큼 모아 손익−수수료를 실현손익에 더한다.
   * 내역을 못 읽으면 손절가(마크가 손절 쪽을 지났으면)·익절가·마크로 추정하고 수수료는 명목의 0.05%×2 로 잡는다. 장부 행은 지운다
   */
  private async settleVanished(f: FollowRow, adapter: BrokerAdapter, book: CopyPositionRow, prices: Prices, contracts: Contracts): Promise<BookResult> {
    const c = contracts[book.symbol];
    let pnl: number | null = null;
    let how = '';
    try {
      const hist = await adapter.getHistory(1, contracts);
      const fills = hist.filter((i) => i.symbol === book.symbol && i.kind !== 'open' && i.direction === book.direction && i.time >= book.openedAt - 1000).sort((a, b) => b.time - a.time);
      let left = book.contracts; let sum = 0; let used = 0;
      for (const it of fills) {
        if (left <= 0) break;
        const q = Math.min(it.contracts, left);
        const frac = it.contracts > 0 ? q / it.contracts : 0;
        sum += ((it.pnl ?? 0) - (it.fee ?? 0)) * frac;
        left -= q; used += q;
      }
      if (used > 0) { pnl = r2(sum); how = `거래 내역 ${used}계약`; }
    } catch (e) { log.warn('copy settle history failed', { followerId: f.followerId, symbol: book.symbol, message: (e as Error).message }); }
    if (pnl == null) {
      const mark = freshMark(prices, book.symbol) || prices[book.symbol]?.mark || prices[book.symbol]?.last || book.entryPrice;
      const d = book.direction;
      const slHit = book.slPrice != null && book.slPrice > 0 && (d === 'long' ? mark <= book.slPrice : mark >= book.slPrice);
      const tpHit = book.tpPrice != null && book.tpPrice > 0 && (d === 'long' ? mark >= book.tpPrice : mark <= book.tpPrice);
      const exit = slHit ? book.slPrice! : tpHit ? book.tpPrice! : mark;
      pnl = r2(pnlOf(book.entryPrice, exit, book.contracts, c.contractSize, d) - feeEst(book.contracts, c.contractSize, book.entryPrice, exit));
      how = `${slHit ? '손절가' : tpHit ? '익절가' : '지금 가격'} ${fmtP(exit)} 기준 추정`;
    }
    await addRealizedPnl(this.env.DB, f.id, pnl);
    await reduceCopyPosition(this.env.DB, f.followerId, book.symbol, book.contracts);
    log.info('copy book settled (position gone)', { followerId: f.followerId, symbol: book.symbol, contracts: book.contracts, pnl, how });
    return { status: 'skipped', detail: `${VANISHED_DETAIL} · 손익 약 ${fmtPnl(pnl)} USDT (${how})`, orderId: null, contracts: 0 };
  }

  /** tpsl 이벤트: 고수의 손절·익절 절대가를 팔로워 포지션에. 손절은 절대 지우지 않고, 내 돈 기준 slRoi 보다 느슨해지지 않는다. 마크를 지난 값은 건너뛰고 기록 */
  private async mirrorTpSl(f: FollowRow, book: CopyPositionRow, ev: CopyEvent, mark: number, contract: ContractInfo, real: Position, adapter: BrokerAdapter): Promise<BookResult> {
    const d = real.direction;
    const notes: string[] = [];
    const upd: { symbol: Symbol; stopLossPrice?: number | null; takeProfitPrice?: number | null } = { symbol: book.symbol };
    // 고수가 손절을 지우면 나도 지운다 (고수와 완전히 동일 — 손실 한도가 마지막 방어선)
    if (ev.slPrice == null || !(ev.slPrice > 0)) { if (real.stopLossPrice != null) { upd.stopLossPrice = null; notes.push('고수가 손절을 지워 내 손절도 해제'); } }
    else {
      const masterSl = roundToPrecision(ev.slPrice, contract.pricePrecision);
      if (!slSideOk(masterSl, mark, d)) notes.push(`손절가 ${fmtP(masterSl)}가 지금 가격(${fmtP(mark)})을 지나쳐 적용 불가`);
      else {
        const lev = real.leverage > 0 ? real.leverage : book.leverage;
        const ownSl = roundToPrecision(priceAtRoi(real.entryPrice, f.settings.slRoi, lev, d, 'sl'), contract.pricePrecision);
        let sl = masterSl;   // 고수 값 그대로
        void ownSl;
        const liq = real.liquidationPrice ?? estimateLiquidation(real.entryPrice, lev, d);
        const g = guardSl(sl, liq, d, contract);
        if (g.note) notes.push(g.note.trim());
        if (Math.abs(g.sl - (real.stopLossPrice ?? 0)) >= contract.pricePrecision) upd.stopLossPrice = g.sl;
      }
    }
    if (ev.tpPrice == null || !(ev.tpPrice > 0)) { if (real.takeProfitPrice != null) upd.takeProfitPrice = null; }
    else {
      const tp = roundToPrecision(ev.tpPrice, contract.pricePrecision);
      if (!tpSideOk(tp, mark, d)) notes.push(`익절가 ${fmtP(tp)}가 지금 가격(${fmtP(mark)})을 지나쳐 적용 불가`);
      else if (real.takeProfitPrice == null || Math.abs(tp - real.takeProfitPrice) >= contract.pricePrecision) upd.takeProfitPrice = tp;
    }
    if (upd.stopLossPrice === undefined && upd.takeProfitPrice === undefined) return { status: 'skipped', detail: notes.length ? notes.join(' · ') : '이미 같은 손절·익절', orderId: null, contracts: 0 };
    await adapter.updateTpSl(upd, contract);
    await setCopyPositionTpSl(this.env.DB, f.followerId, book.symbol, upd.stopLossPrice, upd.takeProfitPrice);
    const parts = [upd.stopLossPrice !== undefined ? (upd.stopLossPrice === null ? '손절 해제' : `손절 ${fmtP(upd.stopLossPrice)}`) : '', upd.takeProfitPrice !== undefined ? (upd.takeProfitPrice === null ? '익절 해제' : `익절 ${fmtP(upd.takeProfitPrice)}`) : ''].filter(Boolean);
    return { status: 'ok', detail: `${parts.join(' · ')}${notes.length ? ` (${notes.join(' · ')})` : ''}`, orderId: null, contracts: 0 };
  }

  /** leverage 이벤트: 고수 배율을 팔로워 상한(팔로우 설정·앱 설정·거래소)으로 잘라 적용. 바뀐 강제정리 가격에 맞춰 손절을 다시 점검한다 */
  private async mirrorLeverage(f: FollowRow, book: CopyPositionRow, ev: CopyEvent, appMaxLeverage: number, contract: ContractInfo, real: Position, adapter: BrokerAdapter): Promise<BookResult> {
    const wanted = Math.max(1, Math.floor(ev.leverage || 1));
    const lev = Math.max(1, Math.min(wanted, Math.floor(f.settings.maxLeverage), Math.floor(appMaxLeverage), Math.floor(contract.maxLeverage || wanted)));
    const capNote = lev !== wanted ? ` (고수 ${wanted}배, 내 상한 적용)` : '';
    if (lev === book.leverage) return { status: 'skipped', detail: `이미 ${lev}배${capNote}`, orderId: null, contracts: 0 };
    try { await adapter.setLeverage(book.symbol, lev); }
    catch (e) {
      if (e instanceof WooxError) return { status: 'skipped', detail: `${LEVERAGE_REFUSED_DETAIL} (${e.code}: ${e.message})`, orderId: null, contracts: 0 };
      throw e;
    }
    await setCopyPositionLeverage(this.env.DB, f.followerId, book.symbol, lev);
    // 배율이 바뀌면 강제정리 가격이 바뀐다 → 손절이 그 밖이면 안쪽으로, 내 돈 기준 한도보다 느슨하면 한도로
    const d = real.direction;
    const curSl = real.stopLossPrice ?? book.slPrice ?? null;
    let note = '';
    if (curSl != null && curSl > 0) {
      const ownSl = roundToPrecision(priceAtRoi(real.entryPrice, f.settings.slRoi, lev, d, 'sl'), contract.pricePrecision);
      const g = guardSl(curSl, estimateLiquidation(real.entryPrice, lev, d), d, contract);
      // 배율 변경 과정에서 예약 주문을 뺐다 다시 걸 수 있으므로(어댑터 40012 우회) 값이 같아도 한 번 더 적용해 손절이 반드시 걸려 있게 한다
      await adapter.updateTpSl({ symbol: book.symbol, stopLossPrice: g.sl }, contract).catch((e) => log.warn('copy sl re-guard after leverage failed', { followerId: f.followerId, message: (e as Error).message }));
      if (Math.abs(g.sl - curSl) >= contract.pricePrecision) {
        await setCopyPositionTpSl(this.env.DB, f.followerId, book.symbol, g.sl, undefined);
        note = ` · 손절 ${fmtP(curSl)}→${fmtP(g.sl)} (새 배율 기준)`;
      }
    }
    return { status: 'ok', detail: `배율 ${book.leverage}→${lev}배${capNote}${note}`, orderId: null, contracts: 0 };
  }

  /**
   * 장부 포지션 n 계약 정리. 실제 포지션이 장부로 다 설명되고 전량이면 closePosition, 아니면 reducePosition(장부 수량만 — 사용자가 직접 넣은 물량은 건드리지 않는다).
   * 실제 포지션이 없거나 방향이 다르면(손절 등으로 이미 정리됨) 장부만 정산한다. 실제가 장부보다 작으면(직접 일부 정리) 그만큼만 정리하고 장부 행은 통째로 지운다
   */
  private async closeBook(f: FollowRow, adapter: BrokerAdapter, book: CopyPositionRow, n: number, mark: number, contract: ContractInfo, real: Position | null, prices: Prices, contracts: Contracts, clientOrderId?: string): Promise<BookResult> {
    const env = this.env;
    if (!real || real.direction !== book.direction) return this.settleVanished(f, adapter, book, prices, contracts);
    const qty = Math.min(Math.floor(n), real.contracts, book.contracts);
    if (qty <= 0) return { status: 'skipped', detail: '정리할 수량 없음', orderId: null, contracts: 0 };
    const emptiesBook = qty >= book.contracts || qty >= real.contracts;   // 실제가 장부보다 작으면 남는 장부는 유령 → 통째로
    const exitOf = (res: CloseResult | void) => (mark > 0 ? mark : real.markPrice || book.entryPrice) || (res ? 0 : 0);
    /** 체결된 만큼 장부·실현손익 반영. emptyAll=false 면 체결분만 뺀다 (일부 정리 실패 시 장부를 통째로 지우지 않는다) */
    const record = async (done: number, res: CloseResult | void, emptyAll = emptiesBook) => {
      const exit = exitOf(res);
      const pnl = res && res.pnl != null ? r2(res.pnl - (res.fee ?? 0)) : r2(pnlOf(book.entryPrice, exit, done, contract.contractSize, book.direction) - feeEst(done, contract.contractSize, book.entryPrice, exit));
      const left = await reduceCopyPosition(env.DB, f.followerId, book.symbol, emptyAll ? book.contracts : done);
      await addRealizedPnl(env.DB, f.id, pnl);
      return { pnl, left };
    };
    const opts = clientOrderId ? { clientOrderId } : {};
    let res: CloseResult | void;
    let forcedFull = false;   // 일부 정리가 40016(강제정리 유발)로 거절돼 전량 정리로 대체했는가
    try {
      if (qty >= real.contracts && real.contracts <= book.contracts) res = await adapter.closePosition(book.symbol, contract, opts);
      else {
        try { res = await adapter.reducePosition(book.symbol, qty, contract, opts); }
        catch (e) {
          // 실측(2026-09-22 05:26, 팔로워 9명): 격리 마진에 잔고를 전부 넣은 팔로워가 손실 중 포지션을 일부만 정리하면 실현 손실이 남은 포지션 증거금에서 빠져
          // 강제정리선을 넘기므로 거래소가 40016("This order would trigger user position liquidate")으로 거절한다. 그대로 두면 고수는 줄였는데 팔로워는 전량 노출 →
          // 위험이 더 작은 쪽인 전량 정리로 대체한다 (고수가 다시 늘리면 새 진입으로 따라간다)
          const liq = e instanceof WooxError && (String(e.code) === '40016' || /liquidat/i.test(String(e.message)));
          if (!liq) throw e;
          log.warn('copy partial close refused (would liquidate) — closing full position instead', { followerId: f.followerId, symbol: book.symbol, qty, real: real.contracts, message: (e as Error).message });
          forcedFull = true;
          res = await adapter.closePosition(book.symbol, contract, clientOrderId ? { clientOrderId: `${clientOrderId}f`.slice(0, 32) } : {});
        }
      }
    } catch (e) {
      // 일부만 체결된 채 실패: 체결된 만큼만 장부·실현손익에 반영(장부는 남긴다)하고 실패로 알린다 — 남은 수량은 다음 이벤트·점검이 다시 정리
      if (e instanceof HttpError && (e.code === 'PARTIAL_CLOSE' || e.code === 'ORDER_SENT_UNCONFIRMED')) {
        const filled = Number((e.detail as { filled?: number } | undefined)?.filled) || 0;
        if (filled > 0) await record(Math.min(filled, qty), undefined, false).catch((err) => log.warn('copy partial close record failed', { followerId: f.followerId, message: (err as Error).message }));
        return { status: 'failed', detail: humanizeCopyError(e), orderId: null, contracts: Math.min(filled, qty) };
      }
      throw e;
    }
    const fullQty = forcedFull ? Math.min(real.contracts, book.contracts) : qty;
    const done = res && res.contracts > 0 ? Math.min(res.contracts, fullQty) : fullQty;
    const { pnl, left } = await record(done, res, forcedFull ? true : emptiesBook);
    const how = forcedFull ? '일부 정리가 거래소에서 거절돼(강제정리 위험 40016) 전량 정리' : emptiesBook ? '전량 정리' : `일부 정리 (${left}계약 남음)`;
    return { status: 'ok', detail: `${how} ${done}계약 · 손익 약 ${fmtPnl(pnl)} USDT`, orderId: null, contracts: done, fillPrice: closeFillPrice(res) };
  }

  /** 장부 전량 정리. requireFresh 면(손실 한도 경로) 시세가 오래된 종목은 시장가로 정리하지 않고 다음 점검으로 미룬다 */
  /** 초과 물량 줄이기: 팔로워 장부 수량 − (고수의 마지막 전량 정리 이후 이 팔로워가 실제로 따라 들어간 수량) 만큼 정리. 일부 정리가 거절되면 closeBook 이 전량 정리로 대체한다 */
  private async trimExcess(masterId: number): Promise<{ followerId: number; symbol: string; book: number; target: number; status: string; detail: string | null }[]> {
    const env = this.env; const out: { followerId: number; symbol: string; book: number; target: number; status: string; detail: string | null }[] = [];
    const followers = await listActiveFollowers(env.DB, masterId);
    const paper = new PaperClient(env);
    const [contracts, pr] = await Promise.all([getContracts(), paper.prices()]);
    for (const f of followers) {
      const books = await listCopyPositions(env.DB, f.followerId, masterId);
      for (const b of books) {
        const lastFlat = await env.DB.prepare("SELECT MAX(seq) s FROM copy_events WHERE master_id = ? AND symbol = ? AND kind = 'close'").bind(masterId, b.symbol).first<{ s: number | null }>();
        const later = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN e.kind IN ('open','add') AND x.status = 'ok' THEN x.contracts ELSE 0 END), 0) entered, SUM(e.kind = 'reduce') reduces FROM copy_events e LEFT JOIN copy_executions x ON x.event_id = e.id AND x.follower_id = ? WHERE e.master_id = ? AND e.symbol = ? AND e.seq > ?").bind(f.followerId, masterId, b.symbol, lastFlat?.s ?? 0).first<{ entered: number; reduces: number | null }>();
        const target = Math.max(0, Math.round(later?.entered ?? 0));
        if ((later?.reduces ?? 0) > 0) { out.push({ followerId: f.followerId, symbol: b.symbol, book: b.contracts, target, status: 'skipped', detail: '이후 축소 이벤트가 있어 자동 계산하지 않음' }); continue; }
        if (!(b.contracts > target)) { out.push({ followerId: f.followerId, symbol: b.symbol, book: b.contracts, target, status: 'skipped', detail: '초과 없음' }); continue; }
        const r = await this.enqueue([b.symbol], async () => {
          const { adapter, mode } = await this.adapterFor(f.followerId, paper);
          if (!adapter || mode !== f.mode) return { status: 'skipped' as const, detail: 'API 키 없음/모드 변경' };
          const acc = await adapter.getAccount(contracts, pr.prices);
          const real = acc.positions.find((p) => p.symbol === b.symbol) ?? null;
          const fresh = (await listCopyPositions(env.DB, f.followerId, masterId)).find((x) => x.symbol === b.symbol);
          if (!fresh || !(fresh.contracts > target)) return { status: 'skipped' as const, detail: '초과 없음' };
          const res = await this.closeBook(f, adapter, fresh, fresh.contracts - target, freshMark(pr.prices, b.symbol), contracts[b.symbol], real, pr.prices, contracts, `cpT${f.followerId}t${Date.now().toString(36)}`.slice(0, 32));
          return { status: res.status, detail: res.detail };
        }).catch((e) => ({ status: 'failed' as const, detail: humanizeCopyError(e) }));
        log.warn('copy trim excess', { followerId: f.followerId, symbol: b.symbol, book: b.contracts, target, ...r });
        out.push({ followerId: f.followerId, symbol: b.symbol, book: b.contracts, target, status: r.status, detail: r.detail });
      }
    }
    return out;
  }

  /** 고수가 이미 정리(또는 반대 방향)한 종목의 남은 장부를 시장가로 정리. 정리된 종목 목록을 돌려준다 */
  private async sweepMissedCloses(f: FollowRow, adapter: BrokerAdapter, books: CopyPositionRow[], prices: Prices, contracts: Contracts, positions: Position[]): Promise<Symbol[]> {
    if (books.length === 0) return [];
    const ms = await getMasterState(this.env.DB, f.masterId);
    const now = Date.now();
    const targets: CopyPositionRow[] = [];
    for (const b of books) {
      const st = ms.get(b.symbol);
      if (!st) continue;
      const masterGone = !(st.contracts > 0) || (st.direction != null && st.direction !== b.direction);
      if (!masterGone) continue;
      const last = await latestEventFor(this.env.DB, f.masterId, b.symbol);
      // 아직 처리 중인 정리 이벤트가 있으면 그쪽에 맡긴다 (이중 정리 방지). 처리된 지 20초가 지났는데 장부가 남아 있을 때만
      if (!last || last.processedAt == null || now - last.processedAt < MISSED_CLOSE_GRACE_MS) continue;
      targets.push(b);
    }
    if (targets.length === 0) return [];
    log.warn('copy missed close detected — closing follower book at market', { followerId: f.followerId, symbols: targets.map((t) => t.symbol) });
    const results = await this.closeBooks(f, adapter, targets, prices, contracts, positions, false, `cpS${f.followerId}t${now.toString(36)}`);
    this.ctx.waitUntil(notifySwept(this.env, f, results));
    return results.filter((r) => r.status === 'ok').map((r) => r.symbol);
  }

  private async closeBooks(f: FollowRow, adapter: BrokerAdapter, books: CopyPositionRow[], prices: Prices, contracts: Contracts, positions?: Position[], requireFresh = false, clientOrderPrefix?: string): Promise<{ symbol: Symbol; status: Status; detail: string | null }[]> {
    const out: { symbol: Symbol; status: Status; detail: string | null }[] = [];
    if (books.length === 0) return out;
    const pos = positions ?? (await adapter.getAccount(contracts, prices)).positions;
    for (const [i, b] of books.entries()) {
      const mark = freshMark(prices, b.symbol);
      if (requireFresh && !(mark > 0)) { out.push({ symbol: b.symbol, status: 'skipped', detail: '시세가 오래돼 정리를 미뤘어요' }); continue; }
      const real = pos.find((p) => p.symbol === b.symbol) ?? null;
      const r = await this.closeBook(f, adapter, b, b.contracts, mark, contracts[b.symbol], real, prices, contracts, clientOrderPrefix ? `${clientOrderPrefix}s${i}`.slice(0, 32) : undefined).catch((e) => {
        log.warn('copy book close failed', { followerId: f.followerId, symbol: b.symbol, message: (e as Error).message });
        return { status: 'failed' as const, detail: humanizeCopyError(e), orderId: null, contracts: 0 };
      });
      out.push({ symbol: b.symbol, status: r.status, detail: r.detail });
    }
    return out;
  }

  // ---------------- 팔로워 단위 (해지·관리자·60초 점검) ----------------
  /** 팔로워의 장부 포지션 전량 정리 (해지 시 closePositions). 팔로우가 이미 stopped 여도 장부가 있으면 정리한다 */
  private async closeFollower(followerId: number) {
    const env = this.env;
    const follow = (await getActiveFollow(env.DB, followerId)) ?? (await getLatestFollow(env.DB, followerId));
    if (!follow) return { ok: false, reason: '팔로우 기록 없음', results: [] };
    const books = await listCopyPositions(env.DB, followerId);
    if (books.length === 0) return { ok: true, results: [] };
    const { adapter } = await this.adapterFor(followerId, new PaperClient(env));
    if (!adapter) return { ok: false, reason: 'API 키 없음', results: [] };
    const [pr, contracts] = await Promise.all([new PaperClient(env).prices(), getContracts()]);
    const results = await this.closeBooks(follow, adapter, books, pr.prices, contracts, undefined, false, `cpU${followerId}t${Date.now().toString(36)}`);
    return { ok: results.every((r) => r.status !== 'failed'), results };
  }

  /** 손실 한도 정리 일부 실패: 정리 못 한 종목을 "정리하지 못한 포지션" 으로 남기고(사용자 화면, D1 0024) 관리자에게 알린다. 팔로우는 계속 재시도. 절대 던지지 않는다 */
  private async noteLossLimitPartial(f: FollowRow, results: { symbol: Symbol; status: Status; detail: string | null }[]): Promise<void> {
    const failed = results.filter((r) => r.status !== 'ok' && !(r.detail ?? '').startsWith(VANISHED_DETAIL)).map((r) => r.symbol);
    await snapshotLeftovers(this.env.DB, f, 'loss_limit_partial', failed).catch((e) => log.warn('copy leftover snapshot failed', { followerId: f.followerId, message: (e as Error).message }));
    await notifyLossLimitPartial(this.env, f, results);
  }

  /** 손실 한도 점검 (60초 알람에서 호출). 먼저 장부를 실제 계좌와 맞추고(손절로 사라진 것 정산), 넘었으면 장부 전량 정리 + stopped(loss_limit) */
  private async checkLoss(followerId: number) {
    const env = this.env;
    const follow = await getActiveFollow(env.DB, followerId);
    if (!follow) return { ok: false, reason: '따라가는 중이 아님', stopped: false, used: 0 };
    // 방금 실행(진입·정리)이 있었으면 이번 점검은 건너뜀 — 점검의 계좌 조회가 실행과 같은 2초 창에서 키 한도를 갉아먹어 429 를 만들었다 (2026-10-01)
    if (follow.mode === 'live') {   // 거래소 키 한도는 실거래에만 있다 (연습 엔진은 즉시 점검)
      const recent = await env.DB.prepare('SELECT 1 FROM copy_executions WHERE follower_id = ? AND mode = ? AND created_at > ? LIMIT 1').bind(followerId, 'live', Date.now() - 8_000).first().catch(() => null);
      if (recent) return { ok: true, stopped: false, used: 0, reason: '실행 직후라 점검 건너뜀' };
    }
    const [rawBooks, pr, contracts] = await Promise.all([listCopyPositions(env.DB, followerId, follow.masterId), new PaperClient(env).prices(), getContracts()]);
    const { adapter, mode } = await this.adapterFor(followerId, new PaperClient(env));
    if (!adapter || mode !== follow.mode) {
      const used = lossLimitUsed(follow.settings.copyAmount, follow.settings.lossLimitPct, follow.realizedPnl, unrealizedOf(rawBooks, pr.prices, contracts));
      return { ok: true, stopped: false, used, reason: !adapter ? 'API 키 없음' : MODE_SWITCH_DETAIL };
    }
    const acc = await adapter.getAccount(contracts, pr.prices);
    const books = await this.reconcileBooks(follow, adapter, rawBooks, acc.positions, pr.prices, contracts);
    const fresh = await getActiveFollow(env.DB, followerId);   // 정산으로 실현손익이 바뀌었을 수 있다
    if (!fresh) return { ok: false, reason: '따라가는 중이 아님', stopped: false, used: 0 };
    // 놓친 정리 보정(안전망): 고수는 그 종목을 이미 정리했거나 방향을 바꿨는데(마지막 이벤트 처리 후 20초 경과) 내 장부가 남아 있으면 — 정리 신호가 429 등으로 실패한 경우 — 시장가로 정리한다
    const swept = await this.sweepMissedCloses(fresh, adapter, books, pr.prices, contracts, acc.positions).catch((e) => { log.warn('copy missed-close sweep failed', { followerId, message: (e as Error).message }); return [] as Symbol[]; });
    const liveBooks = swept.length ? books.filter((b) => !swept.includes(b.symbol)) : books;
    const used = lossLimitUsed(fresh.settings.copyAmount, fresh.settings.lossLimitPct, fresh.realizedPnl, unrealizedOf(liveBooks, pr.prices, contracts));
    if (used < 1) return { ok: true, stopped: false, used, ...(swept.length ? { swept } : {}) };
    const results = await this.closeBooks(fresh, adapter, books, pr.prices, contracts, acc.positions, true, `cpL${followerId}t${Date.now().toString(36)}`);
    // 전부 정리됐을 때만 멈춘다 (시세 오래됨·일부 정리 실패면 장부·팔로우를 남기고 다음 점검에서 재시도)
    if (!allBooksSettled(results)) { log.warn('copy loss limit: partial close, retry next check', { followerId, results }); this.ctx.waitUntil(this.noteLossLimitPartial(fresh, results)); return { ok: true, stopped: false, used, results, deferred: true, detail: LOSS_LIMIT_PARTIAL_DETAIL }; }
    await stopFollow(env.DB, fresh.id, 'loss_limit');
    await deleteCopyPositions(env.DB, followerId);
    this.ctx.waitUntil(notifyLossLimit(env, fresh, results));
    log.info('copy loss limit hit', { followerId, followId: fresh.id, used });
    return { ok: true, stopped: true, used, results };
  }
}

/** 장부 포지션의 미실현 손익 합계 — 진입·정리 수수료 추정(명목의 0.05%×2)을 뺀 값 (손실 한도 판정용). 시세가 없거나 30초 넘게 오래된 종목은 0 */
export function unrealizedOf(books: CopyPositionRow[], prices: Prices, contracts: Contracts): number {
  let sum = 0;
  for (const b of books) {
    const mark = freshMark(prices, b.symbol);
    const size = contracts[b.symbol]?.contractSize ?? 0;   // 종목이 목록에서 빠졌으면 건너뜀 (TypeError 로 점검 전체가 죽지 않게, 감사 A19)
    if (!(size > 0)) continue;
    if (mark > 0) sum += pnlOf(b.entryPrice, mark, b.contracts, size, b.direction) - roundTripFee(b.contracts, size, b.entryPrice, mark);
  }
  return sum;
}
