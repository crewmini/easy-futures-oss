// 카피 팔로우 정지 훅(키 삭제·연습 전환·신분증 거절·탈퇴) + 거래 내역 출처 'copy'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION, type TradeHistoryResponse } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { createFollow, getFollow, getMaster, insertCopyExecution, insertEvent, upsertCopyPosition } from '../copy/db.js';

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
const login = async (loginId: string) => { cookie = ''; const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password: '123456' }) }); expect(r.status).toBe(200); };
const SETTINGS = { copyAmount: 100, lossLimitPct: 50, maxLeverage: 10, slRoi: 30 };
async function mkMaster(loginId: string, uid: string, nickname: string) {
  const id = await mkUser(loginId, uid);
  await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, decided_at, created_at) VALUES (?, ?, NULL, 'approved', ?, 1, 2, 1)").bind(id, nickname, MASTER_TERMS_VERSION).run();
  return id;
}
/** 실거래 모드 + 가짜 키 행 (복호화는 실패해도 키 삭제 라우트는 행만 지운다) */
async function fakeLive(userId: number) {
  await env.DB.prepare("INSERT INTO settings (user_id, mode) VALUES (?, 'live') ON CONFLICT(user_id) DO UPDATE SET mode = 'live'").bind(userId).run();
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (user_id, enc, iv, preview, updated_at) VALUES (?, 'x', 'y', 'wp_…', 1)").bind(userId).run();
}

describe('copy hooks', () => {
  beforeAll(async () => { await prices({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }); });
  beforeEach(() => { cookie = ''; });

  it('deleting the api key stops my follow (no_api_key) and suspends me as a master', async () => {
    const masterId = await mkMaster('hkmaster1', '91242001', '훅고수하나');
    const otherMaster = await mkMaster('hkmaster2', '91242002', '훅고수둘');
    // 고수하나는 다른 고수(둘)를 따라가는 팔로워이기도 하다
    const myFollow = await createFollow(env.DB, masterId, otherMaster, 'live', SETTINGS, COPY_TERMS_VERSION);
    const f1 = await mkUser('hkfollow1', '91242003');
    const theirFollow = await createFollow(env.DB, f1, masterId, 'paper', SETTINGS, COPY_TERMS_VERSION);
    await fakeLive(masterId);
    await login('hkmaster1');
    const r = await call('/keys', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.copyStopped).toBe(true); expect(r.body.masterSuspended).toBe(true);
    expect((await getFollow(env.DB, myFollow))?.stopReason).toBe('no_api_key');
    expect((await getFollow(env.DB, theirFollow))?.stopReason).toBe('master_suspended');
    const m = await getMaster(env.DB, masterId);
    expect(m?.status).toBe('suspended'); expect(m?.decidedBy).toBe('system'); expect(m?.note).toBe('API 키 삭제');
    expect((await getMaster(env.DB, otherMaster))?.status).toBe('approved'); // 남의 고수 상태는 그대로
  });

  it('switching mode stops the follow (mode_switch); an approved master switching to paper is suspended', async () => {
    const masterId = await mkMaster('hkmaster3', '91242004', '훅고수셋');
    const f = await mkUser('hkfollow2', '91242005');
    const followId = await createFollow(env.DB, f, masterId, 'live', SETTINGS, COPY_TERMS_VERSION);
    await fakeLive(f);
    await login('hkfollow2');
    let r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'paper' }) });
    expect(r.status).toBe(200); expect(r.body.copyStopped).toBe(true); expect(r.body.autoDisabled).toBeUndefined();
    expect((await getFollow(env.DB, followId))?.stopReason).toBe('mode_switch');
    // 연습 → 연습 (모드 변화 없음) 은 아무것도 멈추지 않는다
    const again = await createFollow(env.DB, f, masterId, 'paper', SETTINGS, COPY_TERMS_VERSION);
    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ maxLeverage: 5 }) });
    expect(r.status).toBe(200); expect(r.body.copyStopped).toBeUndefined();
    expect((await getFollow(env.DB, again))?.status).toBe('active');
    // 승인된 고수가 연습으로 바꾸면 고수 중지 + 팔로워 전부 정지
    await fakeLive(masterId);
    await login('hkmaster3');
    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'paper' }) });
    expect(r.status).toBe(200); expect(r.body.masterSuspended).toBe(true);
    const m = await getMaster(env.DB, masterId);
    expect(m?.status).toBe('suspended'); expect(m?.note).toBe('연습 모드로 전환');
    expect((await getFollow(env.DB, again))?.stopReason).toBe('master_suspended');
  });

  it('kyc reject stops the follow (kyc_rejected); account delete cleans up', async () => {
    const masterId = await mkMaster('hkmaster4', '91242006', '훅고수넷');
    const f = await mkUser('hkfollow3', '91242007');
    const followId = await createFollow(env.DB, f, masterId, 'paper', SETTINGS, COPY_TERMS_VERSION);
    await mkUser('adminuser', '91242008');
    await login('adminuser');
    let r = await post(`/admin/kyc/${f}`, { action: 'reject', note: '흐림' });
    expect(r.status).toBe(200);
    expect((await getFollow(env.DB, followId))?.stopReason).toBe('kyc_rejected');

    // 탈퇴: 팔로워 장부·팔로우 정리 + (고수면) 팔로우 전부 정지·마스터 행 삭제
    const g = await mkUser('hkfollow4', '91242009');
    const gFollow = await createFollow(env.DB, g, masterId, 'paper', SETTINGS, COPY_TERMS_VERSION);
    await upsertCopyPosition(env.DB, { followerId: g, masterId, symbol: 'SOLUSDT', direction: 'long', contracts: 1, entryPrice: 100, leverage: 2 });
    await login('hkfollow4');
    r = await post('/auth/delete-account', { password: '123456' });
    expect(r.status).toBe(200);
    expect((await getFollow(env.DB, gFollow))?.stopReason).toBe('account_deleted');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM copy_positions WHERE follower_id = ?').bind(g).first<{ n: number }>())?.n).toBe(0);
    const h = await mkUser('hkfollow5', '91242010');
    const hFollow = await createFollow(env.DB, h, masterId, 'paper', SETTINGS, COPY_TERMS_VERSION);
    await login('hkmaster4');
    r = await post('/auth/delete-account', { password: '123456' });
    expect(r.status).toBe(200);
    expect(await getMaster(env.DB, masterId)).toBeNull();
    expect((await getFollow(env.DB, hFollow))?.stopReason).toBe('master_suspended');
  });

  it('history: a flow opened by a copy execution is source copy and lands in bySource.copy', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'hksrc1', password: '123456', uid: '91242011', termsAgreed: true, termsVersion: TERMS_VERSION }) });
    expect(r.status).toBe(200);
    const userId = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'hksrc1'").first<{ id: number }>())!.id;
    const masterId = await mkMaster('hkmaster5', '91242012', '훅고수다섯');
    // 1) 직접 진입 → 정리 (manual)
    r = await post('/order/open', { symbol: 'ETHUSDT', direction: 'long', amountUsdt: 50, leverage: 5, stopLossPrice: 2_400 });
    expect(r.status).toBe(200);
    r = await post('/position/close', { symbol: 'ETHUSDT' });
    expect(r.status).toBe(200);
    // 2) 진입 주문 id 를 카피 실행 기록에 연결 → copy 흐름
    r = await post('/order/open', { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 80, leverage: 5, stopLossPrice: 76_000 });
    expect(r.status).toBe(200);
    const orderId = r.body.orderId as string;
    expect(orderId).toMatch(/^paper-/);
    const eventId = `copy-${masterId}-BTCUSDT-1`;
    await insertEvent(env.DB, { id: eventId, masterId, seq: 1, symbol: 'BTCUSDT', kind: 'open', direction: 'long', beforeContracts: 0, afterContracts: 5, price: 80_000, leverage: 5, masterEquity: 10_000, createdAt: Date.now() });
    expect(await insertCopyExecution(env.DB, eventId, userId, 'paper', 'ok', null, orderId, 5)).toBe(true);
    r = await post('/position/close', { symbol: 'BTCUSDT' });
    expect(r.status).toBe(200);

    r = await call('/history?days=7');
    expect(r.status).toBe(200);
    const h = r.body as unknown as TradeHistoryResponse;
    const bySymbol = (s: string) => h.items.filter((i) => i.symbol === s).map((i) => i.source);
    expect(bySymbol('ETHUSDT')).toEqual(['manual', 'manual']);
    expect(bySymbol('BTCUSDT')).toEqual(['copy', 'copy']);
    expect(h.bySource.copy?.closedCount).toBe(1); expect(h.bySource.manual.closedCount).toBe(1); expect(h.bySource.auto.closedCount).toBe(0);
    expect(h.closedCount).toBe(2);
    // 내 실행 내역에도 흐름 손익이 붙는다 (수수료만큼 손실)
    r = await call('/copy/executions');
    expect(r.status).toBe(200);
    const ex = (r.body.executions as { eventId: string; pnl?: number | null }[]).find((e) => e.eventId === eventId)!;
    expect(ex).toBeDefined(); expect(typeof ex.pnl).toBe('number'); expect(ex.pnl!).toBeLessThan(0);
  });
});
