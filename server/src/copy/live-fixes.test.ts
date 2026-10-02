// 실거래 개방 전 보강(2026-09-18): 방향 해석·손절 삭제 게이트·진입 가드·일부 정리 문구·손실 한도 부분 실패·킬 스위치·장부 클램프·client_order_id
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { calcContracts, COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION, type AdminCopyResponse, type CopyFollowSettings, type Symbol } from '@easy-futures/shared';
import { positionDirection } from '../adapters/woox.js';
import { WooxError, type WooxPositionV2 } from '../woox/client.js';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { HttpError } from '../errors.js';
import { FALLBACK_CONTRACTS } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { addRealizedPnl, applyMaster, copyClientOrderId, createFollow, finishEvent, getFollow, insertCopyExecutions, insertEvent, listCopyPositions, listEventExecutions, masterHasBookPositions, setMasterStatus, upsertMasterState } from './db.js';
import { allBooksSettled, copyStub, humanizeCopyError, LOSS_LIMIT_PARTIAL_DETAIL, NO_SL_CLOSED_DETAIL, PAUSED_DETAIL, unrealizedOf } from './CopyTrader.js';
import { gateSlRemoval } from './MasterWatcher.js';
import { ENTRY_DRIFT_DETAIL, ENTRY_MAX_AGE_MS, ENTRY_MAX_DRIFT, ENTRY_STALE_DETAIL, entryGuardReason, roundTripFee } from './sizing.js';

const ETH = FALLBACK_CONTRACTS.ETHUSDT;
const SOL = FALLBACK_CONTRACTS.SOLUSDT;
const J = { 'content-type': 'application/json' };
const paper = () => new PaperClient(env);
const FOLLOW: CopyFollowSettings = { copyAmount: 500, lossLimitPct: 50, maxLeverage: 10, slRoi: 50 };

async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
async function mkMaster(loginId: string, uid: string) {
  const id = await mkUser(loginId, uid);
  await applyMaster(env.DB, id, loginId, '테스트 고수', MASTER_TERMS_VERSION);
  expect(await setMasterStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
  return id;
}
/** 시세 주입 (일부 종목만 가능) + PaperClient 1초 캐시 만료 대기. 가짜 시계(Date 만)일 때는 기다리는 대신 시계를 1.1초 앞으로 */
async function setPrices(p: Partial<Record<Symbol, number>>) {
  await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) });
  if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 1_100);
  else await new Promise((r) => setTimeout(r, 1100));
}
let seqBy = new Map<number, number>();
/** 감시 DO 없이 이벤트를 직접 넣고 실행기에 던진다 (고수 계정이 관리자일 필요가 없다) */
async function runEvent(masterId: number, e: { kind: 'open' | 'add' | 'reduce' | 'close' | 'tpsl'; symbol?: Symbol; direction?: 'long' | 'short'; before?: number; after?: number; price?: number; createdAt?: number; slPrice?: number | null; tpPrice?: number | null }) {
  const seq = (seqBy.get(masterId) ?? 0) + 1;
  seqBy.set(masterId, seq);
  const symbol = e.symbol ?? 'ETHUSDT';
  const id = `copy-${masterId}-${symbol}-${seq}`;
  expect(await insertEvent(env.DB, {
    id, masterId, seq, symbol, kind: e.kind, direction: e.direction ?? 'long', beforeContracts: e.before ?? 0, afterContracts: e.after ?? 200,
    price: e.price ?? 2_500, leverage: 5, masterEquity: 1_000, createdAt: e.createdAt ?? Date.now(), slPrice: e.slPrice === undefined ? 2_300 : e.slPrice, tpPrice: e.tpPrice ?? null,
  })).toBe(true);
  const r = await copyStub(env).fetch('https://copy/run', { method: 'POST', body: JSON.stringify({ eventId: id }), headers: J });
  expect(r.status).toBe(200);
  const execs = Object.fromEntries((await listEventExecutions(env.DB, id)).map((x) => [x.followerId, x]));
  return { id, seq, result: (await r.json()) as { ok: number; fail: number; skipped: number }, execs };
}
const BASE = 'http://localhost/api';
let cookie = '';
async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await SELF.fetch(BASE + path, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });
const login = async (loginId: string) => { cookie = ''; const r = await post('/auth/login', { loginId, password: '123456' }); expect(r.status).toBe(200); };

describe('positionDirection never guesses', () => {
  const row = (o: Partial<WooxPositionV2>): WooxPositionV2 => ({ symbol: 'BTCUSDT', leverage: '5', current_amount: '3', ...o });
  it('explicit fields win: position_side, then position_type, then signed amount', () => {
    expect(positionDirection(row({ position_side: 'long', position_type: 2 }))).toBe('long');
    expect(positionDirection(row({ position_side: 'short' }))).toBe('short');
    expect(positionDirection(row({ position_type: 1 }))).toBe('long');
    expect(positionDirection(row({ position_type: '2' }))).toBe('short');
    expect(positionDirection(row({ position_amount: '-4' }))).toBe('short');
    expect(positionDirection(row({ current_amount: '0' }))).toBeNull();
  });
  it('unsigned amount: cross-checks unrealized pnl sign against mark − avg', () => {
    expect(positionDirection(row({ unrealized_pnl: '1.5', mark_price: '101', open_avg_price: '100' }))).toBe('long');
    expect(positionDirection(row({ unrealized_pnl: '-1.5', mark_price: '101', open_avg_price: '100' }))).toBe('short');
    expect(positionDirection(row({ unrealized_pnl: '2', mark_price: '99', entry_price: '100' }))).toBe('short');
    expect(positionDirection(row({ unrealized_pnl: '-2', mark_price: '99', entry_price: '100' }))).toBe('long');
  });
  it('throws UNKNOWN_DIRECTION when nothing determines it (pnl 0, mark = avg, missing fields)', () => {
    for (const o of [{}, { unrealized_pnl: '0', mark_price: '101', open_avg_price: '100' }, { unrealized_pnl: '3', mark_price: '100', open_avg_price: '100' }, { position_side: 'both', unrealized_pnl: '3' }]) {
      let err: unknown = null;
      try { positionDirection(row(o)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(WooxError);
      expect((err as WooxError).code).toBe('UNKNOWN_DIRECTION');
    }
  });
});

describe('pure helpers', () => {
  it('gateSlRemoval: live SL removal needs two polls; value changes, TP changes and paper masters pass through', () => {
    const tpsl = [{ kind: 'tpsl' as const, direction: 'long' as const, before: 5, after: 5 }];
    const pending = new Set<Symbol>();
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, 2_300, null, true)).toEqual({ emit: [], held: true });
    expect(pending.has('ETHUSDT')).toBe(true);
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, 2_300, null, true)).toEqual({ emit: tpsl, held: false });
    expect(pending.size).toBe(0);
    // 한 번 비었다가 다음 폴링에 다시 보이면(순간 오류) 보류를 풀고 아무 이벤트도 내지 않는다
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, 2_300, null, true).held).toBe(true);
    expect(gateSlRemoval(pending, 'ETHUSDT', [], 2_300, 2_300, true)).toEqual({ emit: [], held: false });
    expect(pending.size).toBe(0);
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, 2_300, 2_350, true)).toEqual({ emit: tpsl, held: false });   // 값 변경은 바로
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, null, 2_350, true)).toEqual({ emit: tpsl, held: false });    // 추가도 바로
    expect(gateSlRemoval(pending, 'ETHUSDT', tpsl, 2_300, null, false)).toEqual({ emit: tpsl, held: false });   // 연습 고수는 게이트 없음
  });
  it('entryGuardReason: age > 10s or drift > 0.5% blocks entries', () => {
    const now = 1_000_000;
    expect(ENTRY_MAX_AGE_MS).toBe(10_000); expect(ENTRY_MAX_DRIFT).toBe(0.005);
    expect(entryGuardReason(now - 9_000, 2_500, 2_505, now)).toBeNull();
    expect(entryGuardReason(now - 10_001, 2_500, 2_500, now)).toBe(ENTRY_STALE_DETAIL);
    expect(entryGuardReason(now, 2_500, 2_512.5, now)).toBeNull();
    expect(entryGuardReason(now, 2_500, 2_513, now)).toBe(ENTRY_DRIFT_DETAIL);
    expect(entryGuardReason(now, 2_500, 2_487, now)).toBe(ENTRY_DRIFT_DETAIL);
    expect(entryGuardReason(now, 0, 2_487, now)).toBeNull();   // 이벤트 가격이 없으면 드리프트 판정 불가 → 통과
  });
  it('humanizeCopyError names the remaining contracts on PARTIAL_CLOSE; allBooksSettled accepts ok + vanished only', () => {
    expect(humanizeCopyError(new HttpError(409, 'x', 'PARTIAL_CLOSE', { filled: 3, remaining: 7 }))).toBe('일부만 정리됨 (7계약 남음) — 다음 이벤트에서 재시도');
    expect(humanizeCopyError(new HttpError(409, 'x', 'PARTIAL_CLOSE', { filled: 3 }))).toBe('일부만 정리됨 (?계약 남음) — 다음 이벤트에서 재시도');
    expect(humanizeCopyError(new Error('boom'))).toBe('boom');
    expect(allBooksSettled([{ status: 'ok', detail: null }, { status: 'skipped', detail: '실제 포지션이 이미 없어 장부만 정리 · 손익 약 -1 USDT' }])).toBe(true);
    expect(allBooksSettled([{ status: 'ok', detail: null }, { status: 'failed', detail: '일부만 정리됨' }])).toBe(false);
    expect(allBooksSettled([{ status: 'skipped', detail: '시세가 오래돼 정리를 미뤘어요' }])).toBe(false);
    expect(allBooksSettled([])).toBe(true);
  });
  it('unrealizedOf subtracts estimated round-trip fees (0.05% × 2 × notional)', () => {
    const now = Date.now();
    const prices = { ETHUSDT: { last: 2_500, mark: 2_500, updatedAt: now } };
    const book = { followerId: 1, masterId: 2, symbol: 'ETHUSDT' as const, direction: 'long' as const, contracts: 100, entryPrice: 2_500, leverage: 5, openedAt: now, updatedAt: now };
    const fee = roundTripFee(100, ETH.contractSize, 2_500, 2_500);
    expect(fee).toBeCloseTo(100 * 0.001 * 5_000 * 0.0005, 9);   // 0.25 USDT
    expect(unrealizedOf([book], prices, FALLBACK_CONTRACTS)).toBeCloseTo(-fee, 9);
    expect(unrealizedOf([book], { ETHUSDT: { last: 2_500, mark: 2_500, updatedAt: now - 31_000 } }, FALLBACK_CONTRACTS)).toBe(0);   // 오래된 시세는 0
  });
  it('copyClientOrderId is ≤32 alphanumerics and unique per event/follower', () => {
    expect(copyClientOrderId(12, 345, 678)).toBe('cp12s345f678');
    expect(copyClientOrderId(12, 345, 678)).toMatch(/^[a-z0-9]{1,32}$/);
    expect(copyClientOrderId(12, 345, 678)).not.toBe(copyClientOrderId(12, 346, 678));
  });
});

describe('CopyTrader (paper) — kill switch, entry guards, loss-limit partial close, book clamp', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('kill switch skips open/add only; close still runs; admin routes expose pausedGlobal / paused', async () => {
    await setPrices({ ETHUSDT: 2_500, BTCUSDT: 80_000, SOLUSDT: 100 });
    const M = await mkMaster('lfmaster1', '93000001');
    const F = await mkUser('lffol1', '93000002');
    await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    await mkUser('adminuser', '93000003');
    await login('adminuser');

    // 정상 진입 + client_order_id 기록
    let r = await runEvent(M, { kind: 'open' });
    expect(r.execs[F].status).toBe('ok');
    expect((await listCopyPositions(env.DB, F))[0]).toMatchObject({ symbol: 'ETHUSDT', contracts: 100 });
    const row = await env.DB.prepare('SELECT client_order_id FROM copy_executions WHERE event_id = ? AND follower_id = ?').bind(r.id, F).first<{ client_order_id: string | null }>();
    expect(row?.client_order_id).toBe(copyClientOrderId(M, r.seq, F));

    // 전체 킬 스위치 → add 건너뜀, close 는 실행
    let a = await post('/admin/copy/pause', { global: true });
    expect(a.status).toBe(200); expect(a.body.pausedGlobal).toBe(true);
    a = await call('/admin/copy');
    expect((a.body as unknown as AdminCopyResponse).pausedGlobal).toBe(true);
    r = await runEvent(M, { kind: 'add', before: 200, after: 400 });
    expect(r.execs[F]).toMatchObject({ status: 'skipped', detail: PAUSED_DETAIL });
    expect(r.result.skipped).toBe(1);
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(100);
    r = await runEvent(M, { kind: 'close', before: 200, after: 0 });
    expect(r.execs[F].status).toBe('ok');
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    expect((await getFollow(env.DB, (await env.DB.prepare('SELECT id FROM copy_follows WHERE follower_id = ?').bind(F).first<{ id: number }>())!.id))!.status).toBe('active');   // 팔로우는 그대로

    // 전체 해제 + 고수별 멈춤 → open 건너뜀; 고수별 해제 → open 실행
    a = await post('/admin/copy/pause', { global: false });
    expect(a.status).toBe(200);
    a = await post(`/admin/copy/masters/${M}/pause`, { paused: true });
    expect(a.status).toBe(200); expect(a.body.paused).toBe(true);
    a = await call('/admin/copy');
    const adm = a.body as unknown as AdminCopyResponse;
    expect(adm.pausedGlobal).toBe(false);
    expect(adm.approved.find((m) => m.userId === M)?.paused).toBe(true);
    r = await runEvent(M, { kind: 'open' });
    expect(r.execs[F]).toMatchObject({ status: 'skipped', detail: PAUSED_DETAIL });
    a = await post(`/admin/copy/masters/${M}/pause`, { paused: false });
    expect(a.status).toBe(200);
    r = await runEvent(M, { kind: 'open' });
    expect(r.execs[F].status).toBe('ok');
    // 검증
    a = await post('/admin/copy/pause', { global: 'yes' });
    expect(a.status).toBe(400);
    a = await post('/admin/copy/masters/999999/pause', { paused: true });
    expect(a.status).toBe(404);
  }, 30_000);

  it('entry guards: stale signal (>10s) and price drift (>0.5%) skip open/add with a clear detail', async () => {
    await setPrices({ ETHUSDT: 2_500 });
    const M = await mkMaster('lfmaster2', '93000011');
    const F = await mkUser('lffol2', '93000012');
    await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    let r = await runEvent(M, { kind: 'open', createdAt: Date.now() - ENTRY_MAX_AGE_MS - 500 });
    expect(r.execs[F]).toMatchObject({ status: 'skipped', detail: ENTRY_STALE_DETAIL });
    r = await runEvent(M, { kind: 'open', price: 2_400 });   // 마크 2500 vs 고수 체결가 2400 = 4%
    expect(r.execs[F]).toMatchObject({ status: 'skipped', detail: ENTRY_DRIFT_DETAIL });
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    r = await runEvent(M, { kind: 'open', price: 2_505 });   // 0.2% 는 통과
    expect(r.execs[F].status).toBe('ok');
    // 정리(close)는 가드를 타지 않는다 — 오래된 신호여도 실행
    r = await runEvent(M, { kind: 'close', before: 200, after: 0, createdAt: Date.now() - 60_000 });
    expect(r.execs[F].status).toBe('ok');
  }, 30_000);

  it('missed close sweep: master already flat + close event failed for the follower → 15s check closes the book at market', async () => {
    await setPrices({ ETHUSDT: 2_500 });
    const M = await mkMaster('lfmaster9', '93000091');
    const F = await mkUser('lffol9', '93000092');
    await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    let r = await runEvent(M, { kind: 'open' });
    expect(r.execs[F].status).toBe('ok');
    await upsertMasterState(env.DB, M, { symbol: 'ETHUSDT', direction: 'long', contracts: 200, entryPrice: 2_500, leverage: 5, equity: 1_000, slPrice: 2_300, tpPrice: null });
    // 고수가 정리했는데 팔로워 실행은 실패(429)로 기록된 상황을 만든다: 이벤트는 처리 완료, 장부·실제 포지션은 남음
    const closeId = `copy-${M}-ETHUSDT-99`;
    expect(await insertEvent(env.DB, { id: closeId, masterId: M, seq: 99, symbol: 'ETHUSDT', kind: 'close', direction: 'long', beforeContracts: 200, afterContracts: 0, price: 2_500, leverage: 5, masterEquity: 1_000, createdAt: Date.now(), slPrice: null, tpPrice: null })).toBe(true);
    await insertCopyExecutions(env.DB, [{ eventId: closeId, followerId: F, mode: 'paper', status: 'failed', detail: '거래소가 잠시 바빠요' }]);
    await finishEvent(env.DB, closeId, 1, 0, 1, 0);
    await upsertMasterState(env.DB, M, { symbol: 'ETHUSDT', direction: null, contracts: 0, entryPrice: null, leverage: null, equity: 1_000, slPrice: null, tpPrice: null });
    expect((await listCopyPositions(env.DB, F)).length).toBe(1);
    // 처리 직후(20초 이내)에는 이중 정리를 피하려 손대지 않는다
    let k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F }), headers: J })).json()) as { ok: boolean; stopped: boolean; swept?: string[] };
    expect(k.swept).toBeUndefined();
    expect((await listCopyPositions(env.DB, F)).length).toBe(1);
    // 20초 뒤 점검: 놓친 정리로 판정해 시장가 정리
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 21_000);
    await setPrices({ ETHUSDT: 2_500 });
    k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F }), headers: J })).json()) as typeof k;
    vi.useRealTimers();
    expect(k).toMatchObject({ ok: true, stopped: false, swept: ['ETHUSDT'] });
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    expect((await paper().state(F)).positions).toEqual([]);
  }, 30_000);

  it('book clamps to the real position when the follower closed part of it directly', async () => {
    await setPrices({ ETHUSDT: 2_500 });
    const M = await mkMaster('lfmaster3', '93000021');
    const F = await mkUser('lffol3', '93000022');
    await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    let r = await runEvent(M, { kind: 'open' });
    expect(r.execs[F].status).toBe('ok');
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(100);
    await paper().reduce(F, 'ETHUSDT', 40);   // 직접 40계약 정리
    expect(await masterHasBookPositions(env.DB, M)).toBe(true);
    const k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F }), headers: J })).json()) as { ok: boolean; stopped: boolean };
    expect(k).toMatchObject({ ok: true, stopped: false });
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(60);
    r = await runEvent(M, { kind: 'close', before: 200, after: 0 });
    expect(r.execs[F]).toMatchObject({ status: 'ok', contracts: 60 });
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    expect((await paper().state(F)).positions).toEqual([]);
    expect(await masterHasBookPositions(env.DB, M)).toBe(false);
  }, 30_000);

  it('loss limit: one symbol cannot be closed (stale price) → books and follow stay, detail says retry; next check finishes and stops', async () => {
    await setPrices({ ETHUSDT: 2_500, SOLUSDT: 100 });
    const M = await mkMaster('lfmaster4', '93000031');
    const F = await mkUser('lffol4', '93000032');
    const fid = await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    let r = await runEvent(M, { kind: 'open', symbol: 'ETHUSDT' });
    expect(r.execs[F].status).toBe('ok');
    r = await runEvent(M, { kind: 'open', symbol: 'SOLUSDT', price: 100, slPrice: 90, after: calcContracts(100, 5, 100, SOL) });
    expect(r.execs[F].status).toBe('ok');
    expect((await listCopyPositions(env.DB, F)).map((b) => b.symbol)).toEqual(['ETHUSDT', 'SOLUSDT']);
    // SOL 시세만 오래되게: 시계를 31초 앞으로 돌리고 ETH 만 다시 주입
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    await setPrices({ ETHUSDT: 2_500 });
    await addRealizedPnl(env.DB, fid, -300);   // 한도 250 초과
    r = await runEvent(M, { kind: 'tpsl', symbol: 'ETHUSDT', before: 200, after: 200, slPrice: 2_350 });
    expect(r.execs[F]).toMatchObject({ status: 'skipped', detail: LOSS_LIMIT_PARTIAL_DETAIL });
    let fr = (await getFollow(env.DB, fid))!;
    expect(fr.status).toBe('active');
    expect((await listCopyPositions(env.DB, F)).map((b) => b.symbol)).toEqual(['SOLUSDT']);   // ETH 는 정리됨, SOL 은 남음
    expect((await paper().state(F)).positions.map((p) => p.symbol)).toEqual(['SOLUSDT']);
    // 점검 경로도 같은 규칙 (SOL 은 아직 오래된 시세 → 미룸)
    let k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F }), headers: J })).json()) as { ok: boolean; stopped: boolean; deferred?: boolean };
    expect(k).toMatchObject({ ok: true, stopped: false, deferred: true });
    // SOL 시세가 다시 신선해지면 다음 점검에서 정리하고 멈춘다
    await setPrices({ SOLUSDT: 100 });
    k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F }), headers: J })).json()) as typeof k;
    expect(k).toMatchObject({ ok: true, stopped: true });
    fr = (await getFollow(env.DB, fid))!;
    expect(fr).toMatchObject({ status: 'stopped', stopReason: 'loss_limit' });
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    expect((await paper().state(F)).positions).toEqual([]);
    expect(NO_SL_CLOSED_DETAIL).toContain('손절');
  }, 60_000);
});
