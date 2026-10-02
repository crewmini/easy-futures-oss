// 카피 운영 안전 (2026-09-22): 정리하지 못한 포지션(leftovers) 스냅샷·확인, 한 지갑 공유 가드(COPY_SYMBOL_LOCKED / force), 포지션 배지, 슬리피지 노출
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import type { AdminCopyResponse, AppState, CopyExecution, CopyStateResponse } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { createFollow, getFollow, insertCopyExecution, insertEvent, listLeftovers, snapshotLeftovers, updateCopyExecution, upsertCopyPosition } from '../copy/db.js';
import { notifyDeps } from '../copy/notify.js';

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
async function prices(p: Record<string, number>) { await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) }); }
async function mkUser(loginId: string, uid: string) {
  const exists = await env.DB.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first<{ id: number }>();
  if (exists) return exists.id;
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
async function mkMaster(loginId: string, uid: string, nickname: string) {
  const id = await mkUser(loginId, uid);
  await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, decided_at, created_at) VALUES (?, ?, NULL, 'approved', ?, 1, 2, 1)").bind(id, nickname, MASTER_TERMS_VERSION).run();
  return id;
}
const login = async (loginId: string) => { cookie = ''; const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password: '123456' }) }); expect(r.status).toBe(200); };
const settings = { copyAmount: 100, lossLimitPct: 50, maxLeverage: 10, slRoi: 30 };
const state = async () => (await call('/copy')).body as unknown as CopyStateResponse;

const realSend = notifyDeps.send;
/** 알림 중복 제거 행이 생길 때까지(최대 2초) — 알림이 나갔다는 증거 */
async function waitFlag(key: string) {
  let flag: { value: string } | null = null;
  for (let i = 0; i < 20 && !flag; i++) { flag = await env.DB.prepare('SELECT value FROM copy_flags WHERE key = ?').bind(key).first<{ value: string }>(); if (!flag) await new Promise((res) => setTimeout(res, 100)); }
  expect(Number(flag?.value)).toBeGreaterThan(0);
}

describe('copy leftovers + shared-wallet guard', () => {
  beforeAll(async () => { await prices({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }); notifyDeps.send = async () => undefined; });
  beforeEach(() => { cookie = ''; });

  it('admin stop keeps a leftover snapshot; user sees it until ack; admin list counts it', async () => {
    const masterId = await mkMaster('lomaster1', '93000001', '남김고수');
    const f1 = await mkUser('lofol1', '93000002');
    const followId = await createFollow(env.DB, f1, masterId, 'paper', settings, COPY_TERMS_VERSION);
    await upsertCopyPosition(env.DB, { followerId: f1, masterId, symbol: 'ETHUSDT', direction: 'long', contracts: 4, entryPrice: 2_400, leverage: 5, slPrice: 2_300, tpPrice: null });
    await upsertCopyPosition(env.DB, { followerId: f1, masterId, symbol: 'SOLUSDT', direction: 'short', contracts: 0, entryPrice: 100, leverage: 3 });   // 수량 0 은 남기지 않는다
    await mkUser('adminuser', '93000003');
    await login('adminuser');
    let r = await post(`/admin/copy/follows/${followId}/stop`, {});
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, stopped: true, leftovers: 1 });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM copy_positions WHERE follower_id = ?').bind(f1).first<{ n: number }>())?.n).toBe(0);   // 장부는 지운다
    r = await call('/admin/copy');
    const a = r.body as unknown as AdminCopyResponse;
    expect(a.follows.find((f) => f.id === followId)).toMatchObject({ status: 'stopped', stopReason: 'admin', leftovers: 1 });
    // 관리자 알림이 나갔는지: SELF 워커는 다른 모듈 인스턴스라 send 스텁이 안 보인다 → 중복 제거 행(notify:leftover:<followId>)으로 확인 (문구·마스킹은 notify.test)
    await waitFlag(`notify:leftover:${followId}`);

    await login('lofol1');
    let s = await state();
    expect(s.me.follow?.status).toBe('stopped');
    expect(s.me.follow?.leftovers).toEqual([{ symbol: 'ETHUSDT', direction: 'long', contracts: 4, entryPrice: 2_400, leverage: 5, reason: 'admin', createdAt: expect.any(Number) }]);
    expect(s.me.follow?.avgSlippagePct).toBeNull();
    r = await post('/copy/leftovers/ack', {});
    expect(r.status).toBe(200); expect(r.body.acked).toBe(1);
    s = await state();
    expect(s.me.follow?.leftovers).toBeUndefined();
    r = await call('/admin/copy');   // 팔로워 세션이라 403 — 관리자로 다시 확인
    await login('adminuser');
    r = await call('/admin/copy');
    expect(((r.body as unknown as AdminCopyResponse).follows.find((f) => f.id === followId) ?? {}) as Record<string, unknown>).not.toHaveProperty('leftovers');
  });

  it('unfollow without closing snapshots the book (reason user); master suspend snapshots every follower', async () => {
    const masterId = await mkMaster('lomaster2', '93000011', '남김고수둘');
    const f2 = await mkUser('lofol2', '93000012');
    const f3 = await mkUser('lofol3', '93000013');
    await login('lofol2');
    let r = await post('/copy/follow', { masterId, ...settings, agree: true, copyTermsVersion: COPY_TERMS_VERSION });
    expect(r.status).toBe(200);
    await upsertCopyPosition(env.DB, { followerId: f2, masterId, symbol: 'BTCUSDT', direction: 'short', contracts: 2, entryPrice: 81_000, leverage: 10 });
    r = await post('/copy/unfollow', { closePositions: false });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, closed: false, leftovers: 1 });
    let s = await state();
    expect(s.me.follow?.leftovers?.[0]).toMatchObject({ symbol: 'BTCUSDT', direction: 'short', contracts: 2, reason: 'user' });
    await waitFlag(`notify:leftover:${s.me.follow!.id}`);   // 관리자 알림(waitUntil)이 끝난 뒤 다음 단계로

    const followId3 = await createFollow(env.DB, f3, masterId, 'paper', settings, COPY_TERMS_VERSION);
    await upsertCopyPosition(env.DB, { followerId: f3, masterId, symbol: 'ETHUSDT', direction: 'long', contracts: 7, entryPrice: 2_450, leverage: 4 });
    await mkUser('adminuser', '93000014');
    await login('adminuser');
    r = await post(`/admin/copy/masters/${masterId}`, { action: 'suspend', note: '점검' });
    expect(r.status).toBe(200); expect(r.body.stoppedFollows).toBe(1);
    expect((await getFollow(env.DB, followId3))?.stopReason).toBe('master_suspended');
    const rows = await listLeftovers(env.DB, f3, true, followId3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'ETHUSDT', direction: 'long', contracts: 7, reason: 'master_suspended', followId: followId3 });
  });

  it('loss-limit partial failure snapshot is per-symbol and idempotent across 15s retries', async () => {
    const masterId = await mkMaster('lomaster3', '93000021', '남김고수셋');
    const f4 = await mkUser('lofol4', '93000022');
    const followId = await createFollow(env.DB, f4, masterId, 'paper', settings, COPY_TERMS_VERSION);
    const follow = (await getFollow(env.DB, followId))!;
    await upsertCopyPosition(env.DB, { followerId: f4, masterId, symbol: 'ETHUSDT', direction: 'long', contracts: 3, entryPrice: 2_500, leverage: 5 });
    await upsertCopyPosition(env.DB, { followerId: f4, masterId, symbol: 'SOLUSDT', direction: 'long', contracts: 9, entryPrice: 100, leverage: 5 });
    // 손실 한도 정리에서 SOL 만 실패 → SOL 만 남긴다 (checkLoss → noteLossLimitPartial 이 부르는 경로)
    let rows = await snapshotLeftovers(env.DB, follow, 'loss_limit_partial', ['SOLUSDT']);
    expect(rows.map((r) => r.symbol)).toEqual(['SOLUSDT']);
    // 다음 점검(15초)에서 또 실패해도 행이 늘지 않고 수량만 갱신
    await upsertCopyPosition(env.DB, { followerId: f4, masterId, symbol: 'SOLUSDT', direction: 'long', contracts: 5, entryPrice: 100, leverage: 5 });
    rows = await snapshotLeftovers(env.DB, follow, 'loss_limit_partial', ['SOLUSDT']);
    expect(rows).toHaveLength(1);
    const left = await listLeftovers(env.DB, f4, true);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ symbol: 'SOLUSDT', contracts: 5, reason: 'loss_limit_partial' });
    await login('lofol4');
    const s = await state();
    expect(s.me.follow?.status).toBe('active');   // 팔로우는 계속 재시도 중
    expect(s.me.follow?.leftovers).toEqual([expect.objectContaining({ symbol: 'SOLUSDT', contracts: 5, reason: 'loss_limit_partial' })]);
  });

  it('manual order/close/tpsl on a copied symbol → 409 COPY_SYMBOL_LOCKED unless force; positions carry the copy badge', async () => {
    const masterId = await mkMaster('lomaster4', '93000031', '잠금고수');
    const f5 = await mkUser('lofol5', '93000032');
    await login('lofol5');
    let r = await post('/copy/follow', { masterId, ...settings, agree: true, copyTermsVersion: COPY_TERMS_VERSION });
    expect(r.status).toBe(200);
    // 먼저 직접 BTC 를 잡아 두고(연습), 그 종목을 장부에 올린다 (따라 들어간 포지션으로 취급)
    const open = { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 50, leverage: 5, stopLossPrice: 70_000 };
    r = await post('/order/open', open);
    expect(r.status).toBe(200);
    await upsertCopyPosition(env.DB, { followerId: f5, masterId, symbol: 'BTCUSDT', direction: 'long', contracts: Number(r.body.contracts), entryPrice: 80_000, leverage: 5 });

    r = await post('/order/open', open);
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_SYMBOL_LOCKED'); expect(r.body.detail).toMatchObject({ symbol: 'BTCUSDT', masterNickname: '잠금고수' });
    r = await post('/position/tpsl', { symbol: 'BTCUSDT', stopLossPrice: 72_000 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_SYMBOL_LOCKED');
    r = await post('/position/close', { symbol: 'BTCUSDT' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_SYMBOL_LOCKED');
    // 다른 종목은 그대로
    r = await post('/order/open', { symbol: 'ETHUSDT', direction: 'long', amountUsdt: 20, leverage: 2, stopLossPrice: 2_000 });
    expect(r.status).toBe(200);
    // 포지션 배지
    const st = (await call('/state')).body as unknown as AppState;
    expect(st.positions.find((p) => p.symbol === 'BTCUSDT')?.copy).toEqual({ masterNickname: '잠금고수' });
    expect(st.positions.find((p) => p.symbol === 'ETHUSDT')?.copy).toBeUndefined();
    // force 로 통과 (웹이 확인 창을 거친 뒤)
    r = await post('/position/tpsl', { symbol: 'BTCUSDT', stopLossPrice: 72_000, force: true });
    expect(r.status).toBe(200);
    r = await post('/order/open', { ...open, force: true });
    expect(r.status).toBe(200);
    r = await post('/position/close', { symbol: 'BTCUSDT', force: true });
    expect(r.status).toBe(200);
  });

  it('slippage: fill price on an ok execution → slippagePct in my executions and 30-day average', async () => {
    const masterId = await mkMaster('lomaster5', '93000041', '슬립고수');
    const f6 = await mkUser('lofol6', '93000042');
    await createFollow(env.DB, f6, masterId, 'paper', settings, COPY_TERMS_VERSION);
    const now = Date.now();
    await insertEvent(env.DB, { id: `copy-${masterId}-ETHUSDT-1`, masterId, seq: 1, symbol: 'ETHUSDT', kind: 'open', direction: 'long', beforeContracts: 0, afterContracts: 10, price: 2_500, leverage: 5, masterEquity: 1_000, createdAt: now - 60_000 });
    await insertEvent(env.DB, { id: `copy-${masterId}-ETHUSDT-2`, masterId, seq: 2, symbol: 'ETHUSDT', kind: 'close', direction: 'long', beforeContracts: 10, afterContracts: 0, price: 2_600, leverage: 5, masterEquity: 1_000, createdAt: now - 30_000 });
    await insertCopyExecution(env.DB, `copy-${masterId}-ETHUSDT-1`, f6, 'paper', 'ok', '오른다 20 USDT 5배 (4계약)', 'o1', 4);
    await updateCopyExecution(env.DB, `copy-${masterId}-ETHUSDT-1`, f6, 'paper', 'ok', '오른다 20 USDT 5배 (4계약)', 'o1', 4, 2_525);   // 1% 비싸게 삼 → +1
    await insertCopyExecution(env.DB, `copy-${masterId}-ETHUSDT-2`, f6, 'paper', 'ok', '전량 정리 4계약', null, 4);
    await updateCopyExecution(env.DB, `copy-${masterId}-ETHUSDT-2`, f6, 'paper', 'ok', '전량 정리 4계약', null, 4, 2_613);   // 0.5% 비싸게 팜 → −0.5 (유리)
    await env.DB.prepare("UPDATE copy_events SET close_reason = 'liquidation' WHERE id = ?").bind(`copy-${masterId}-ETHUSDT-2`).run();
    await login('lofol6');
    const r = await call('/copy/executions');
    expect(r.status).toBe(200);
    const ex = (r.body.executions as CopyExecution[]);
    const byId = Object.fromEntries(ex.map((e) => [e.eventId, e]));
    expect(byId[`copy-${masterId}-ETHUSDT-1`]).toMatchObject({ fillPrice: 2_525, slippagePct: 1 });
    expect(byId[`copy-${masterId}-ETHUSDT-2`]).toMatchObject({ fillPrice: 2_613, slippagePct: -0.5 });
    expect(byId[`copy-${masterId}-ETHUSDT-2`].detail).toBe('고수 강제정리로 정리 · 전량 정리 4계약');
    expect(byId[`copy-${masterId}-ETHUSDT-2`].event?.closeReason).toBe('liquidation');
    const s = await state();
    expect(s.me.follow?.avgSlippagePct).toBeCloseTo(0.25, 6);
  });
});

afterEach(() => { notifyDeps.send = realSend; });
