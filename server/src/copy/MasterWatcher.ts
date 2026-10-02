// 카피 트레이딩: 마스터 계좌 감시 Durable Object (마스터 1명 = 인스턴스 1개, idFromName(`master-<userId>`)) — docs/copy-trading.md §2
// 1차: 거래소 개인 WS(실거래 마스터만) — 어떤 메시지든 "깨우기" 신호로만 쓰고 REST(getAccount)로 정답을 다시 읽는다. WS 내용은 로그인 응답 외엔 믿지 않는다.
// 2차: 알람 폴링 (WS 살아 있으면 5초, 아니면 2초). 심볼별 직전 상태와 비교해 open/add/reduce/close/tpsl/leverage 이벤트를 만들고 CopyTrader 에 던진다.
// 크론(매분)이 /kick 으로 알람을 되살린다. 마스터가 approved 가 아니거나(관리자 제외) 실거래 모드가 아니면 스스로 멈춘다. 마스터 키는 읽기(감시)에만 쓴다.
import { DurableObject } from 'cloudflare:workers';
import { SYMBOLS, type CopyCloseReason, type CopyEventKind, type Direction, type Symbol } from '@easy-futures/shared';
import { PaperAdapter } from '../adapters/paper.js';
import type { BrokerAdapter } from '../adapters/types.js';
import { WooxAdapter } from '../adapters/woox.js';
import { findUserById, getCredsForUser, getSettings } from '../db.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { isAdmin } from '../routes/auth.js';
import { signWebSocketLogin } from '../sign.js';
import { WooxClient, WooxError, type WooxCredentials } from '../woox/client.js';
import { copyStub } from './CopyTrader.js';
import { getActiveFollow, getMaster, getMasterMeta, getMasterState, insertEventStmt, listActiveFollowers, listApprovedMasterIds, listStaleEvents, markMasterPoll, masterHasBookPositions, setEventCloseReason, setMasterSeqStmt, upsertMasterStateStmt, type MasterStateRow } from './db.js';
import { notifyMasterLiquidated, notifyMasterPollFailures } from './notify.js';
import { refreshMasterStats, STATS_TTL_MS } from './stats.js';

export const masterStub = (env: Env, masterId: number) => env.MASTER.get(env.MASTER.idFromName(`master-${masterId}`));

/** 크론(매분): 승인된 마스터 전원의 감시 DO 를 깨운다 (알람이 죽었으면 되살림) */
export async function kickMasters(env: Env): Promise<void> {
  const ids = await listApprovedMasterIds(env.DB);
  // 고수가 많아져도 크론 1회에 DO 호출·D1 이 한꺼번에 몰리지 않게 50개씩 (감사 A27)
  for (let i = 0; i < ids.length; i += 50) {
    await Promise.all(ids.slice(i, i + 50).map((id) => masterStub(env, id).fetch('https://master/kick', { method: 'POST', body: JSON.stringify({ masterId: id }), headers: { 'content-type': 'application/json' } }).catch(() => null)));
  }
}

export const WOOX_USER_WS_URL = 'https://cloud-ws.wooxpro.com/user?protocol=1.1'; // fetch 업그레이드용 (wss → https)
const POLL_WS_UP_MS = 5_000;
const POLL_WS_DOWN_MS = 2_000;
const PING_AFTER_MS = 10_000;      // 이 시간 동안 메시지가 없으면 ping (서버는 20초 무응답 시 끊음). 2초마다 확인
const PING_CHECK_MS = 2_000;
const WS_STALE_MS = 30_000;
const WS_EARLY_CLOSE_MS = 10_000;  // 연결 뒤 이 안에 끊기면 실패로 세어 백오프
const WAKE_DEBOUNCE_MS = 50;
const SHRINK_CONFIRM_MS = 150;   // 축소·정리 재확인 간격
const WS_BACKOFF_MAX_MS = 60_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;  // 개인 WS 업그레이드 fetch 상한 — 매달리면 알람이 영원히 끝나지 않는다 (감사 A3)
const POLL_BACKOFF_MAX_MS = 60_000;   // 폴링 연속 실패 시 지수 백오프 상한 (감사 A6)
const AUTH_FAIL_SLOW_AFTER = 5;       // 키 거절(401/403)이 이만큼 연속이면 5분 간격으로 늦춘다 (자동 정지는 하지 않는다)
const AUTH_FAIL_POLL_MS = 5 * 60_000;
const STALE_EVENT_MS = 20_000;     // 이보다 오래 처리되지 않은 이벤트는 팬아웃을 다시 던진다 (CopyTrader 멱등)
const LOSS_CHECK_MS = 60_000;        // 팔로워 손실 한도 점검: 장부 포지션이 없을 때
const LOSS_CHECK_FAST_MS = 15_000;   // 장부 포지션이 하나라도 있으면 15초마다
const RECOVER_PENDING_MS = 60_000;   // 고아 pending 실행 행 복구 (CopyTrader /recover-pending, 감사 A5)
const META_WRITE_MS = 30_000;      // copy_master_meta 는 30초마다 또는 상태(ws/오류)가 바뀔 때만 쓴다
const CYCLE_ERROR = '고수가 다른 고수를 따라가는 중 — 감시 정지';
const NOT_LIVE_ERROR = '실거래 모드가 아니라 감시 정지 (관리자 계정만 연습 감시 가능)';
const VANISHED_ERROR = '포지션이 모두 사라졌는데 포지션 증거금이 남아 있어요 — 거래소 응답 이상으로 보고 이번 폴링은 건너뜀';
const POLL_FAIL_NOTIFY_AT = 5;        // 폴링 연속 실패가 이만큼이면 관리자 텔레그램 (10분 중복 제거)
const CLOSE_CLASSIFY_BUDGET_MS = 3_000;   // close 이벤트 사유(강제정리/ADL) 분류: 주문 이력 조회 상한. 팬아웃 뒤에 돌므로 신호를 늦추지 않는다
const CLOSE_CLASSIFY_LOOKBACK_SEC = 120;

interface Snapshot { direction: Direction | null; contracts: number; entryPrice: number | null; leverage: number | null; slPrice: number | null; tpPrice: number | null }
export interface DiffEvent { kind: CopyEventKind; direction: Direction; before: number; after: number }

const samePrice = (a: number | null, b: number | null, tol: number) => (a == null || b == null ? a == b : Math.abs(a - b) < Math.max(tol, 1e-9));

/**
 * 심볼 하나의 직전 → 현재 변화를 이벤트 목록으로. 순서: 수량(open/add/reduce/close, 방향 전환은 close+open) → tpsl → leverage.
 * open/add 는 손절·익절·배율을 이미 실어 보내므로 그 폴링에서는 tpsl/leverage 를 따로 내지 않는다.
 */
export function diffSymbol(prev: Snapshot, cur: Snapshot, priceTol = 0): DiffEvent[] {
  const before = prev.contracts > 0 && prev.direction ? prev.contracts : 0;
  const after = cur.contracts > 0 && cur.direction ? cur.contracts : 0;
  const out: DiffEvent[] = [];
  if (before === 0 && after === 0) return out;
  if (before === 0) out.push({ kind: 'open', direction: cur.direction!, before: 0, after });
  else if (after === 0) out.push({ kind: 'close', direction: prev.direction!, before, after: 0 });
  else if (prev.direction !== cur.direction) out.push({ kind: 'close', direction: prev.direction!, before, after: 0 }, { kind: 'open', direction: cur.direction!, before: 0, after });
  else if (after > before) out.push({ kind: 'add', direction: cur.direction!, before, after });
  else if (after < before) out.push({ kind: 'reduce', direction: cur.direction!, before, after });
  const entered = out.some((e) => e.kind === 'open' || e.kind === 'add');
  if (after > 0 && !entered) {
    if (!samePrice(prev.slPrice, cur.slPrice, priceTol) || !samePrice(prev.tpPrice, cur.tpPrice, priceTol)) out.push({ kind: 'tpsl', direction: cur.direction!, before, after });
    if (prev.leverage != null && cur.leverage != null && prev.leverage !== cur.leverage) out.push({ kind: 'leverage', direction: cur.direction!, before, after });
  }
  return out;
}

/**
 * 실거래 마스터의 줄어듦(close/reduce, 방향 전환 포함)은 거래소가 한순간 빈 목록을 돌려줘도 팔로워를 몽땅 정리하지 않도록
 * 두 번 연속 관측돼야 낸다. pending 에 (종목 → 관측한 계약 수)를 두고, 다음 폴링이 같거나 더 작으면 확정. 늘어남·손절 변경은 바로.
 * held=true 면 이번엔 아무것도 내지 않고 기준선도 갱신하지 않는다 (다음 폴링이 같은 기준선과 비교).
 */
export function gateShrink(pending: Map<Symbol, number>, symbol: Symbol, events: DiffEvent[], curContracts: number, needConfirm: boolean): { emit: DiffEvent[]; held: boolean } {
  const shrink = events.some((e) => e.kind === 'close' || e.kind === 'reduce');
  if (!needConfirm || !shrink) { pending.delete(symbol); return { emit: events, held: false }; }
  const seen = pending.get(symbol);
  if (seen !== undefined && curContracts <= seen) { pending.delete(symbol); return { emit: events, held: false }; }
  pending.set(symbol, curContracts);
  return { emit: [], held: true };
}

/**
 * 실거래 마스터의 손절 "삭제"(있다가 없음)도 두 번 연속 관측돼야 tpsl 이벤트로 낸다 — 플랜 주문 조회가 한순간 빈 목록을 줘도 팔로워 손절을 지우지 않는다.
 * 손절 값 변경·익절 변경은 바로. held=true 면 이번엔 아무것도 내지 않고 기준선도 갱신하지 않는다 (shrink 게이트와 같은 방식, 150ms 뒤 재확인)
 */
export function gateSlRemoval(pending: Set<Symbol>, symbol: Symbol, events: DiffEvent[], prevSl: number | null, curSl: number | null, needConfirm: boolean): { emit: DiffEvent[]; held: boolean } {
  const removal = events.some((e) => e.kind === 'tpsl') && prevSl != null && prevSl > 0 && !(curSl != null && curSl > 0);
  if (!needConfirm || !removal) { pending.delete(symbol); return { emit: events, held: false }; }
  if (pending.has(symbol)) { pending.delete(symbol); return { emit: events, held: false }; }
  pending.add(symbol);
  return { emit: [], held: true };
}

/**
 * "포지션이 전부 사라졌는데 증거금이 남음" = 거래소 응답 이상 의심 → 이번 폴링을 버린다.
 * positionMargin 은 계좌 전체(XRP 등 미지원 종목 포함)이므로 앱 종목 필터 전 원본 포지션 수(rawPositionCount)가 0 일 때만 의심한다 —
 * 고수가 미지원 종목을 들고 있으면 앱 종목을 전부 정리한 뒤 매 폴링이 영구 실패해 close 이벤트가 절대 안 나갔다 (감사 A2). 연습 어댑터는 rawPositionCount 없음(=0 취급)
 */
export function vanishedSuspect(first: boolean, prevOpen: number, curOpen: number, rawPositionCount: number | undefined, positionMargin: number): boolean {
  return !first && prevOpen > 0 && curOpen === 0 && (rawPositionCount ?? 0) === 0 && positionMargin > 0;
}

/** 주문 이력에서 고수 정리 사유 분류: liquidate/bankruptcy → liquidation, adl → adl, 그 외 → normal (BitMart order type — adapters/woox.ts getHistory 와 같은 기준) */
export function classifyCloseOrders(orders: { type?: unknown; side?: unknown }[]): CopyCloseReason {
  let reason: CopyCloseReason = 'normal';
  for (const o of orders) {
    const t = String(o.type ?? '').toLowerCase();
    const side = Number(o.side);
    if (side === 1 || side === 4) continue;   // 진입 주문은 무시 (one_way: 1=롱 진입, 4=숏 진입)
    if (t === 'liquidate' || t === 'bankruptcy') return 'liquidation';
    if (t === 'adl') reason = 'adl';
  }
  return reason;
}

/** WS 업그레이드 fetch 에 연결 시간 상한만 건다. AbortSignal.timeout 을 그대로 넘기면 연결이 된 뒤에도 타이머가 터지며 소켓이 끊긴다(배포 직후 5초마다 재연결 관측) — 응답이 오면 타이머를 해제한다 */
async function fetchUpgrade(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { headers: { Upgrade: 'websocket' }, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export class MasterWatcher extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private wsAuthed = false;
  private wsConnectedAt = 0;
  private lastMsgAt = 0;
  private connecting: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wsFailures = 0;
  private nextWsAttemptAt = 0;
  private polling: Promise<string[]> | null = null;
  private lastLossCheckAt = 0;
  /** 진행 중인 손실 점검 — 끝나기 전에는 새 점검을 쌓지 않는다 (감사 A1) */
  private lossCheckInflight: Promise<void> | null = null;
  private lastRecoverAt = 0;
  private recoverInflight: Promise<void> | null = null;
  private pollFailures = 0;          // 연속 폴링 실패 수 (성공 시 0) — 알람 간격 백오프
  private authFailures = 0;          // 연속 키 거절(401/403) 수
  private lastPollError: unknown = null;
  private lastStatsAt = 0;
  private lastPollAt: number | null = null;
  private lastMeta: { at: number; wsOk: boolean; error: string | null } = { at: 0, wsOk: false, error: null };
  private cachedMasterId: number | null = null;
  private seq: number | null = null;
  /** 실거래 마스터의 줄어듦 확인 대기 (종목 → 관측 계약 수) */
  private pendingShrink = new Map<Symbol, number>();
  /** 실거래 마스터의 손절 삭제 확인 대기 (종목) */
  private pendingSlRemoval = new Set<Symbol>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const masterId = await this.masterId(request, url);
    if (!masterId) return Response.json({ ok: false, error: 'masterId 를 알 수 없어요 (idFromName("master-<id>") 또는 본문 masterId)' }, { status: 400 });
    if (url.pathname === '/kick' && request.method === 'POST') {
      const why = await this.notWatchable(masterId);
      if (why) { await this.stop(); return Response.json({ ok: false, reason: why, alarm: null }); }
      await this.ensureAlarm();
      return Response.json({ ok: true, alarm: await this.ctx.storage.getAlarm() });
    }
    if (url.pathname === '/poll' && request.method === 'POST') {
      const busy = !!this.polling;
      const ids = await this.pollOnce(masterId);
      const results = await this.dispatch(ids);   // 명시적 폴링(관리자·테스트)은 팬아웃까지 기다린다
      return Response.json({ ok: true, busy, events: ids, results });
    }
    if (url.pathname === '/status') {
      const meta = await getMasterMeta(this.env.DB, masterId);
      return Response.json({ wsOk: this.wsUp(), wsRecorded: meta.wsOk, lastPollAt: this.lastPollAt ?? meta.lastPollAt, lastError: this.lastMeta.at ? this.lastMeta.error : meta.lastError, alarm: await this.ctx.storage.getAlarm(), seq: this.seq ?? meta.seq, pollFailures: this.pollFailures, authFailures: this.authFailures });
    }
    if (url.pathname === '/stop' && request.method === 'POST') { await this.stop(); return Response.json({ ok: true }); }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // ---------------- 신원·알람 ----------------
  /** DO 이름(master-<id>) → 본문/쿼리 masterId → 저장된 값 순으로 알아낸다 */
  private async masterId(request: Request, url: URL): Promise<number | null> {
    if (this.cachedMasterId) return this.cachedMasterId;
    let id = Number((this.ctx.id.name ?? '').replace(/^master-/, '')) || Number(url.searchParams.get('masterId')) || 0;
    if (!id && request.method === 'POST') {
      try { id = Number(((await request.clone().json()) as { masterId?: number })?.masterId) || 0; } catch { /* 본문 없음 */ }
    }
    if (!id) id = (await this.ctx.storage.get<number>('masterId')) ?? 0;
    if (!id) return null;
    this.cachedMasterId = id;
    await this.ctx.storage.put('masterId', id);
    return id;
  }
  private async storedMasterId(): Promise<number | null> {
    return this.cachedMasterId ?? (Number((this.ctx.id.name ?? '').replace(/^master-/, '')) || (await this.ctx.storage.get<number>('masterId')) || null);
  }

  /** 감시 가능 조건: approved + (실거래 모드 또는 관리자 계정). 아니면 사유 문자열 */
  private async notWatchable(masterId: number): Promise<string | null> {
    const m = await getMaster(this.env.DB, masterId);
    if (m?.status !== 'approved') return '승인된 고수가 아님';
    const settings = await getSettings(this.env, masterId);
    if (settings.mode !== 'live') {
      const u = await findUserById(this.env.DB, masterId);
      if (!u || !isAdmin(this.env, u.login_id)) return NOT_LIVE_ERROR;
    }
    return null;
  }

  private async ensureAlarm(): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur < Date.now() - POLL_WS_DOWN_MS * 5) await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  private async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.dropSocket();
  }

  async alarm(): Promise<void> {
    let masterId: number | null = null;
    let rearm = true;   // 조건 미달(미승인·연습)로 스스로 멈출 때만 false — D1 일시 오류는 catch 로 빠져 finally 에서 다시 건다 (감사 A26)
    try {
      masterId = await this.storedMasterId();
      if (!masterId) { rearm = false; return; }
      const why = await this.notWatchable(masterId);
      if (why) { rearm = false; this.dropSocket(); if (why !== '승인된 고수가 아님') await this.writeMeta(masterId, why).catch(() => {}); return; }   // 조건 미달 → 알람을 다시 걸지 않고 멈춘다
      // WS 연결은 기다리지 않는다 — 업그레이드가 매달려도 알람(폴링)은 계속 돈다 (감사 A3)
      void this.ensureWs(masterId).catch((e) => log.warn('copy master ensureWs failed', { masterId, message: (e as Error).message }));
      const ids = await this.pollOnce(masterId);
      this.ctx.waitUntil(this.dispatch(ids));
      this.ctx.waitUntil(this.recoverStale(masterId));
      // 손실 한도 점검: 팔로워 장부 포지션이 있으면 15초, 없으면 60초. 직전 점검이 아직 돌고 있으면 쌓지 않고 건너뛴다 (완료 시각 기준)
      const sinceLoss = Date.now() - this.lastLossCheckAt;
      if (!this.lossCheckInflight && (sinceLoss >= LOSS_CHECK_MS || (sinceLoss >= LOSS_CHECK_FAST_MS && (await masterHasBookPositions(this.env.DB, masterId).catch(() => false))))) {
        this.lossCheckInflight = this.checkFollowersLoss(masterId).finally(() => { this.lastLossCheckAt = Date.now(); this.lossCheckInflight = null; });
        this.ctx.waitUntil(this.lossCheckInflight);
      }
      // 고아 pending 실행 행 복구: 60초마다, 같은 in-flight 규칙 (감사 A5)
      if (!this.recoverInflight && Date.now() - this.lastRecoverAt >= RECOVER_PENDING_MS) {
        this.recoverInflight = this.recoverPending(masterId).finally(() => { this.lastRecoverAt = Date.now(); this.recoverInflight = null; });
        this.ctx.waitUntil(this.recoverInflight);
      }
      // 공개 목록 통계는 누가 프로필을 열지 않아도 ≈5분마다 갱신 (updated_at 게이트가 중복 계산을 막는다)
      if (Date.now() - this.lastStatsAt >= STATS_TTL_MS) { this.lastStatsAt = Date.now(); this.ctx.waitUntil(refreshMasterStats(this.env, masterId).then(() => undefined).catch(() => undefined)); }
    } catch (e) {
      this.pollFailures++;
      this.lastPollError = e;
      log.error('copy master alarm failed', { masterId, failures: this.pollFailures, message: (e as Error).message });
    } finally {
      if (rearm) await this.ctx.storage.setAlarm(Date.now() + this.nextPollDelay());
    }
  }

  /**
   * 다음 폴링까지 간격: 기본(WS 살아 있으면 5초, 아니면 2초) × 2^연속실패(최대 5), 상한 60초 (감사 A6).
   * 거래소가 429 로 Retry-After 를 주면 그보다 짧게 가지 않는다 (감사 A9). 키 거절이 5회 연속이면 5분 — 고수를 자동 중지하진 않는다
   */
  private nextPollDelay(): number {
    const base = this.wsUp() ? POLL_WS_UP_MS : POLL_WS_DOWN_MS;
    if (this.pollFailures === 0) return base;
    if (this.authFailures >= AUTH_FAIL_SLOW_AFTER) return AUTH_FAIL_POLL_MS;
    let next = Math.min(POLL_BACKOFF_MAX_MS, base * 2 ** Math.min(this.pollFailures, 5));
    const retryAfter = Number((this.lastPollError as { retryAfterMs?: number } | null)?.retryAfterMs);
    if (Number.isFinite(retryAfter) && retryAfter > 0) next = Math.max(next, retryAfter);
    return next;
  }

  /** 폴링 실패 집계: 연속 실패 수 + 키 거절(401/403·서명·권한) 연속 수. 5회 연속 키 거절이면 오류 로그 1회 */
  private notePollFailure(e: unknown): void {
    this.pollFailures++;
    this.lastPollError = e;
    const w = e instanceof WooxError ? e : null;
    const auth = !!w && (w.httpStatus === 401 || w.httpStatus === 403 || /signature|api ?key|permission|auth/i.test(String(w.message)));
    this.authFailures = auth ? this.authFailures + 1 : 0;
    if (auth && this.authFailures === AUTH_FAIL_SLOW_AFTER) log.error('copy master api key rejected repeatedly — polling slowed to 5 min (not suspended)', { failures: this.authFailures, code: w?.code, http: w?.httpStatus });
  }
  private notePollSuccess(): void { this.pollFailures = 0; this.authFailures = 0; this.lastPollError = null; }

  // ---------------- 폴링 → 디프 → 이벤트 ----------------
  private pollOnce(masterId: number): Promise<string[]> {
    if (this.polling) return this.polling;
    this.polling = this.poll(masterId).finally(() => { this.polling = null; });
    return this.polling;
  }

  private async adapterFor(masterId: number): Promise<{ adapter: BrokerAdapter; live: boolean; creds: WooxCredentials | null }> {
    const settings = await getSettings(this.env, masterId);
    if (settings.mode === 'live') {
      const creds = await getCredsForUser(this.env, masterId);
      if (!creds) throw new Error('API 키 없음');
      return { adapter: new WooxAdapter(new WooxClient({ credentials: creds, gate: makeRateGate(this.env) })), live: true, creds };
    }
    const u = await findUserById(this.env.DB, masterId);
    if (!u || !isAdmin(this.env, u.login_id)) throw new Error(NOT_LIVE_ERROR);
    return { adapter: new PaperAdapter(new PaperClient(this.env), masterId), live: false, creds: null };
  }

  /** 이벤트 번호: DO 저장소가 단일 작성자. 처음엔 D1 meta 의 seq 에서 이어간다 */
  private async nextSeq(masterId: number): Promise<number> {
    if (this.seq === null) {
      const stored = await this.ctx.storage.get<number>('seq');
      const meta = await getMasterMeta(this.env.DB, masterId);
      this.seq = Math.max(stored ?? 0, meta.seq);
    }
    this.seq += 1;
    await this.ctx.storage.put('seq', this.seq);
    return this.seq;
  }

  /** copy_master_meta 쓰기 절약: 30초마다 또는 wsOk/오류가 바뀔 때만 */
  private async writeMeta(masterId: number, error: string | null): Promise<void> {
    const wsOk = this.wsUp();
    const now = Date.now();
    this.lastPollAt = now;
    if (error === this.lastMeta.error && wsOk === this.lastMeta.wsOk && now - this.lastMeta.at < META_WRITE_MS) return;
    this.lastMeta = { at: now, wsOk, error };
    await markMasterPoll(this.env.DB, masterId, wsOk, error);
  }

  /** 한 번 폴링. 첫 폴링(상태 행 없음)은 기준선만 기록하고 이벤트를 내지 않는다. 만든 이벤트 id 목록 반환. D1 쓰기는 폴링당 batch 1회 */
  private async poll(masterId: number): Promise<string[]> {
    const db = this.env.DB;
    const created: string[] = [];
    let confirmSoon = false;   // 축소·정리는 두 번 읽어야 확정 — 다음 알람(최대 5초)을 기다리지 않고 바로 다시 읽는다
    try {
      // 고수가 다른 고수를 따라가는 중이면 그 계좌의 변화는 남의 신호 — 증폭을 막기 위해 감시하지 않는다
      if (await getActiveFollow(db, masterId)) { await this.writeMeta(masterId, CYCLE_ERROR); this.notePollSuccess(); return created; }
      const { adapter, live, creds } = await this.adapterFor(masterId);
      const [contracts, pr] = await Promise.all([getContracts(), new PaperClient(this.env).prices()]);
      const acc = await adapter.getAccount(contracts, pr.prices);
      const prev = await getMasterState(db, masterId);
      const first = prev.size === 0;
      const equity = acc.wallet.equity;
      // 열려 있던 종목이 한 번에 전부 사라졌는데 포지션 증거금이 남아 있으면 거래소 응답 이상 → 이번 폴링은 버린다
      const prevOpen = [...prev.values()].filter((s) => s.contracts > 0 && s.direction).length;
      const curOpen = acc.positions.filter((p) => p.contracts > 0).length;
      if (vanishedSuspect(first, prevOpen, curOpen, acc.rawPositionCount, acc.wallet.positionMargin)) throw new Error(VANISHED_ERROR);
      const stmts: D1PreparedStatement[] = [];
      const eventIdAt: (string | null)[] = [];   // stmts 와 같은 길이: 이벤트 삽입문이면 그 id, 아니면 null
      const closeIds = new Map<string, Symbol>();   // close 이벤트 id → 종목 (사유 분류용)
      for (const symbol of SYMBOLS) {
        const pos = acc.positions.find((p) => p.symbol === symbol);
        const stored = prev.get(symbol);
        const old: Snapshot = stored
          ? { direction: stored.direction, contracts: stored.contracts, entryPrice: stored.entryPrice, leverage: stored.leverage, slPrice: stored.slPrice ?? null, tpPrice: stored.tpPrice ?? null }
          : { direction: null, contracts: 0, entryPrice: null, leverage: null, slPrice: null, tpPrice: null };
        // 플랜 주문 조회가 실패한 종목(tpslUnknown)은 "손절 없음" 이 아니라 "모름" → 직전 손절·익절을 그대로 이어간다 (삭제 이벤트를 내지 않는다)
        const tpslUnknown = !!pos?.tpslUnknown;
        const cur: Snapshot = {
          direction: pos?.direction ?? null, contracts: pos?.contracts ?? 0, entryPrice: pos?.entryPrice ?? null, leverage: pos ? Math.max(1, Math.round(pos.leverage)) : null,
          slPrice: tpslUnknown ? old.slPrice : pos?.stopLossPrice ?? null, tpPrice: tpslUnknown ? old.tpPrice : pos?.takeProfitPrice ?? null,
        };
        if (tpslUnknown) log.warn('copy master tpsl unknown — carrying forward previous sl/tp', { masterId, symbol, slPrice: old.slPrice, tpPrice: old.tpPrice });
        const diff = first ? [] : diffSymbol(old, cur, contracts[symbol]?.pricePrecision ?? 0);
        const shrinkGate = gateShrink(this.pendingShrink, symbol, diff, cur.contracts, live);
        if (shrinkGate.held) { log.info('copy master shrink pending confirmation', { masterId, symbol, before: old.contracts, after: cur.contracts }); confirmSoon = true; continue; }   // 기준선 유지 — 아래에서 즉시 재확인
        const { emit: events, held } = gateSlRemoval(this.pendingSlRemoval, symbol, shrinkGate.emit, old.slPrice, cur.slPrice, live);
        if (held) { log.info('copy master sl removal pending confirmation', { masterId, symbol, prevSl: old.slPrice }); confirmSoon = true; continue; }
        if (!first && events.length === 0) continue;   // 변화 없음 → 쓰기 생략
        const price = pos?.markPrice || pr.prices[symbol]?.mark || pr.prices[symbol]?.last || old.entryPrice || 0;
        for (const d of events) {
          const seq = await this.nextSeq(masterId);
          const id = `copy-${masterId}-${symbol}-${seq}`;
          const leverage = d.kind === 'close' ? (old.leverage ?? cur.leverage ?? 1) : (cur.leverage ?? old.leverage ?? 1);
          stmts.push(insertEventStmt(db, {
            id, masterId, seq, symbol, kind: d.kind, direction: d.direction, beforeContracts: d.before, afterContracts: d.after, price, leverage, masterEquity: equity, createdAt: Date.now(),
            slPrice: d.kind === 'close' ? old.slPrice : cur.slPrice, tpPrice: d.kind === 'close' ? old.tpPrice : cur.tpPrice,
          }));
          eventIdAt.push(id);
          if (d.kind === 'close') closeIds.set(id, symbol);
          log.info('copy master event', { masterId, id, kind: d.kind, symbol, before: d.before, after: d.after });
        }
        const row: Omit<MasterStateRow, 'updatedAt'> = { symbol, direction: cur.contracts > 0 ? cur.direction : null, contracts: cur.contracts, entryPrice: cur.entryPrice, leverage: cur.leverage, equity, slPrice: cur.slPrice, tpPrice: cur.tpPrice };
        stmts.push(upsertMasterStateStmt(db, masterId, row)); eventIdAt.push(null);
      }
      if (stmts.length) {
        if (this.seq !== null) { stmts.push(setMasterSeqStmt(db, masterId, this.seq)); eventIdAt.push(null); }
        const results = await db.batch(stmts);
        // 이벤트 삽입문 결과: 실제로 들어간 id 만 팬아웃 (OR IGNORE 로 무시된 것은 dropped 로 남긴다)
        eventIdAt.forEach((id, i) => {
          if (!id) return;
          if ((results[i]?.meta.changes ?? 0) > 0) created.push(id); else log.warn('copy master event dropped (duplicate id)', { masterId, id });
        });
        // close 이벤트 사유(강제정리/ADL/직접) 분류 — 이벤트는 이미 만들어졌고 팬아웃은 호출자가 던진다. 실거래는 백그라운드(3초 상한), 연습은 거래소가 없으니 normal 로 바로
        const closes = created.filter((id) => closeIds.has(id)).map((id) => ({ id, symbol: closeIds.get(id)! }));
        if (closes.length) {
          if (live && creds) this.ctx.waitUntil(this.classifyCloses(masterId, creds, closes));
          else await Promise.all(closes.map((c) => setEventCloseReason(db, c.id, 'normal').catch(() => undefined)));
        }
      }
      await this.writeMeta(masterId, null);
      this.notePollSuccess();
    } catch (e) {
      this.notePollFailure(e);
      const msg = (e as Error).message ?? String(e);
      log.warn('copy master poll failed', { masterId, failures: this.pollFailures, message: msg });
      if (this.pollFailures === POLL_FAIL_NOTIFY_AT) this.ctx.waitUntil(notifyMasterPollFailures(this.env, masterId, this.pollFailures, msg));
      await this.writeMeta(masterId, msg.slice(0, 200)).catch(() => {});
    }
    if (confirmSoon) this.scheduleConfirm(masterId);
    return created;
  }

  /**
   * 실거래 고수의 close 이벤트 사유 분류 (최선 노력, 3초 상한): 최근 2분 주문 이력에 liquidate/bankruptcy → liquidation, adl → adl, 아니면 normal.
   * 조회 실패면 미분류(NULL)로 둔다. 강제정리·ADL 이면 관리자 텔레그램. 주문은 내지 않는다 (마스터 키는 읽기 전용)
   */
  private async classifyCloses(masterId: number, creds: WooxCredentials, closes: { id: string; symbol: Symbol }[]): Promise<void> {
    const client = new WooxClient({ credentials: creds, timeoutMs: CLOSE_CLASSIFY_BUDGET_MS, gate: makeRateGate(this.env) });
    const endSec = Math.floor(Date.now() / 1000);
    for (const c of closes) {
      try {
        const orders = await client.getOrderHistory(c.symbol, endSec - CLOSE_CLASSIFY_LOOKBACK_SEC, endSec);
        const reason = classifyCloseOrders(orders);
        await setEventCloseReason(this.env.DB, c.id, reason);
        if (reason !== 'normal') {
          log.warn('copy master position liquidated', { masterId, eventId: c.id, symbol: c.symbol, reason });
          await notifyMasterLiquidated(this.env, masterId, c.symbol, reason, c.id);
        }
      } catch (e) {
        log.warn('copy close classify failed (left unclassified)', { masterId, eventId: c.id, message: (e as Error).message });
      }
    }
  }

  /** 축소·정리 확정용 즉시 재폴링 (거래소 일시 오류 방어는 유지하되 지연은 0.2초 안으로) */
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleConfirm(masterId: number): void {
    if (this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      this.ctx.waitUntil((async () => { const ids = await this.pollOnce(masterId); await this.dispatch(ids); })().catch((e) => log.warn('copy shrink confirm poll failed', { message: (e as Error).message })));
    }, SHRINK_CONFIRM_MS);
  }

  /** 이벤트를 CopyTrader 에 던진다. 같은 종목은 순서대로(close→open 보장), 다른 종목은 병렬. 같은 id 를 두 번 던지지 않는다 — 호출자가 새 id 만 넘긴다 */
  private async dispatch(ids: string[], recovery = false): Promise<Record<string, unknown>[]> {
    const groups = new Map<string, string[]>();
    for (const id of ids) { const sym = id.split('-')[2] ?? '*'; const l = groups.get(sym) ?? []; l.push(id); groups.set(sym, l); }
    const out: Record<string, unknown>[] = [];
    await Promise.all([...groups.values()].map(async (list) => {
      for (const eventId of list) {
        try {
          const r = await copyStub(this.env).fetch('https://copy/run', { method: 'POST', body: JSON.stringify({ eventId, recovery }), headers: { 'content-type': 'application/json' } });
          out.push({ eventId, ...((await r.json()) as Record<string, unknown>) });
        } catch (e) {
          log.error('copy dispatch failed', { eventId, message: (e as Error).message });
          out.push({ eventId, error: (e as Error).message });
        }
      }
    }));
    return out;
  }

  /** 팬아웃 호출이 유실된 이벤트(처리 안 된 채 20초 경과)를 다시 던진다. CopyTrader 가 멱등이고, 더 최신 이벤트가 있으면 진입·손절·배율은 건너뛴다 */
  private async recoverStale(masterId: number): Promise<void> {
    const stale = await listStaleEvents(this.env.DB, masterId, STALE_EVENT_MS).catch(() => []);
    if (stale.length) { log.warn('copy stale events re-dispatched', { masterId, ids: stale.map((e) => e.id) }); await this.dispatch(stale.map((e) => e.id), true); }
  }

  /** 60초(장부 있으면 15초)마다 팔로워 손실 한도 점검 (CopyTrader /check-loss — 팔로워마다 그 장부 종목 큐로, 3명씩) */
  private async checkFollowersLoss(masterId: number): Promise<void> {
    const followers = await listActiveFollowers(this.env.DB, masterId).catch(() => []);
    if (followers.length === 0) return;
    await copyStub(this.env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerIds: followers.map((f) => f.followerId) }), headers: { 'content-type': 'application/json' } })
      .catch((e) => log.warn('copy loss check failed', { masterId, message: (e as Error).message }));
  }

  /** 60초마다 고아 pending 실행 행 복구 (이벤트가 이미 processed 여도 — 감사 A5). 전역 조회라 어느 고수 DO 가 불러도 같다 */
  private async recoverPending(masterId: number): Promise<void> {
    await copyStub(this.env).fetch('https://copy/recover-pending', { method: 'POST' })
      .catch((e) => log.warn('copy recover-pending failed', { masterId, message: (e as Error).message }));
  }

  // ---------------- 개인 WebSocket (실거래 마스터만) ----------------
  private wsUp(): boolean { return this.ws !== null && this.wsAuthed && Date.now() - this.lastMsgAt < WS_STALE_MS; }

  private async ensureWs(masterId: number): Promise<void> {
    if (this.ws && Date.now() - this.lastMsgAt >= WS_STALE_MS) this.dropSocket();
    if (this.ws || this.connecting || Date.now() < this.nextWsAttemptAt) return;
    const settings = await getSettings(this.env, masterId);
    if (settings.mode !== 'live') return;   // 연습 마스터는 폴링만
    const creds = await getCredsForUser(this.env, masterId);
    if (!creds) return;
    this.connecting = this.connectWs(masterId, creds).finally(() => { this.connecting = null; });
    await this.connecting;
  }

  private backoff(): void {
    this.wsFailures++;
    this.nextWsAttemptAt = Date.now() + Math.min(WS_BACKOFF_MAX_MS, POLL_WS_DOWN_MS * 2 ** Math.min(this.wsFailures, 6));
  }

  private async connectWs(masterId: number, creds: WooxCredentials): Promise<void> {
    try {
      const res = await fetchUpgrade(WOOX_USER_WS_URL, WS_CONNECT_TIMEOUT_MS);
      const ws = res.webSocket;
      if (!ws) throw new Error(`upgrade failed: HTTP ${res.status}`);
      ws.accept();
      this.ws = ws;
      this.wsAuthed = false;
      this.wsConnectedAt = Date.now();
      this.lastMsgAt = Date.now();
      const ts = Date.now();
      const sign = await signWebSocketLogin(creds.apiSecret, ts, creds.memo);
      ws.send(JSON.stringify({ action: 'access', args: [creds.apiKey, String(ts), sign, 'web'] }));
      ws.send(JSON.stringify({ action: 'subscribe', args: ['futures/position', 'futures/order'] }));
      // 늦게 오는 옛 소켓의 이벤트는 무시 (this.ws 가 바뀐 뒤)
      ws.addEventListener('message', (ev) => { if (this.ws === ws) this.onMessage(String(ev.data)); });
      const onGone = () => {
        if (this.ws !== ws) return;
        if (Date.now() - this.wsConnectedAt < WS_EARLY_CLOSE_MS) this.backoff();   // 연결 직후 끊김 = 실패로 세어 재시도 간격을 늘린다
        this.dropSocket();
      };
      ws.addEventListener('close', onGone);
      ws.addEventListener('error', onGone);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && Date.now() - this.lastMsgAt > PING_AFTER_MS) {
          try { this.ws.send(JSON.stringify({ action: 'ping' })); } catch { this.dropSocket(); }
        }
      }, PING_CHECK_MS);
      // 실패 카운트는 여기서 되돌리지 않는다 — 로그인(access) 성공 시점에만 (잘못된 키가 연결/거절을 무한 반복하지 않게, 감사 A7)
      log.info('copy master ws connected (awaiting login)', { masterId });
    } catch (e) {
      this.ws = null;
      this.backoff();
      log.warn('copy master ws connect failed (polling continues)', { masterId, failures: this.wsFailures, message: (e as Error).message });
    }
  }

  private dropSocket(): void {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this.wsAuthed = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** WS 메시지는 로그인(access) 응답만 해석한다 — 나머지는 내용을 믿지 않고 ping/pong 이 아니면 50ms 안에 REST 폴링 한 번 */
  private onMessage(raw: string): void {
    this.lastMsgAt = Date.now();
    if (/"(pong|ping)"/.test(raw) && raw.length < 80) return;
    if (/"access"/.test(raw) && raw.length < 400) {
      try {
        const m = JSON.parse(raw) as { action?: string; success?: boolean; code?: number | string; error?: unknown };
        if (m.action === 'access') {
          const ok = m.success !== false && !m.error && (m.code === undefined || m.code === 1000 || m.code === 0 || m.code === '1000' || m.code === '0');
          this.wsAuthed = ok;
          if (ok) { this.wsFailures = 0; this.nextWsAttemptAt = 0; }   // 로그인 성공 = 진짜 연결 → 백오프 초기화
          else { log.warn('copy master ws login rejected', { raw: raw.slice(0, 200) }); this.backoff(); this.dropSocket(); }
          return;
        }
      } catch { /* 형식 불명 → 깨우기 신호로만 */ }
    }
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.ctx.waitUntil((async () => {
        const masterId = await this.storedMasterId();
        if (!masterId) return;
        const ids = await this.pollOnce(masterId);
        await this.dispatch(ids);
      })().catch((e) => log.warn('copy ws-wake poll failed', { message: (e as Error).message })));
    }, WAKE_DEBOUNCE_MS);
  }
}
