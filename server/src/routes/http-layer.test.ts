// HTTP/API 계층 안정성 (감사 2026-09-18 B2·B3·B4·B5·B13·B14): 없는 /api 주소 JSON 404, 거래소 실패 시 /state 200,
// 키 복호화 실패 구분, 주문 표식 중복 방지, 접수 뒤 확인 실패 409, 오래된 시세 거절. 거래소는 전역 fetch 를 가로채 흉내낸다.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TERMS_VERSION, type AppState } from '@easy-futures/shared';
import { createUser, getSettings, saveApiKey, saveSettings } from '../db.js';
import { aesEncrypt, pbkdf2Hash, randomSalt } from '../crypto.js';

const BASE = 'http://localhost/api';
let cookie = '';
async function raw(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await SELF.fetch(BASE + path, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}
async function call(path: string, init: RequestInit = {}) {
  const res = await raw(path, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });
const login = async (loginId: string) => { cookie = ''; const r = await post('/auth/login', { loginId, password: '123456' }); expect(r.status).toBe(200); };

/** 실거래 사용자: 신분증 승인 + 키 행(암호화 정상 또는 깨짐) + mode live */
async function mkLiveUser(loginId: string, uid: string, key: 'good' | 'broken') {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  if (key === 'good') {
    const { enc, iv } = await aesEncrypt(env.MASTER_KEY, JSON.stringify({ apiKey: 'k-test', apiSecret: 's-test', memo: 'm' }));
    await saveApiKey(env.DB, u.id, enc, iv, 'k-test…');
  } else {
    await saveApiKey(env.DB, u.id, 'bm9wZQ==', 'bm9wZQ==', 'broken…');   // MASTER_KEY 로 풀리지 않는 암호문
  }
  await saveSettings(env, u.id, { ...(await getSettings(env, u.id)), mode: 'live' });
  return u.id;
}

// ---- 거래소 흉내: 경로별 핸들러를 테스트마다 바꾼다 ----
type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>;
const ok = (data: unknown) => Response.json({ code: 1000, message: 'Ok', data });
const http = (status: number, message = 'err') => Response.json({ code: status, message }, { status });
let exchange: Handler = () => http(500);
let calls: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith('https://cloud-api.wooxpro.com')) return realFetch(input, init);
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/contract/public/details') return ok({ symbols: [] });   // 계약 상세는 폴백 상수로
    return exchange(path, init);
  }) as typeof fetch);
  await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }) });
});
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => { calls = []; exchange = () => http(500); });

describe('B4: unknown /api paths answer JSON 404, never the SPA shell', () => {
  it('GET /api/nope and wrong method on a real path (logged in)', async () => {
    await mkLiveUser('httpu1', '91261001', 'good');
    await login('httpu1');
    let res = await raw('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: '없는 주소예요', code: 'NOT_FOUND' });
    res = await raw('/health', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    cookie = '';
    res = await raw('/nope/deeper');   // 로그인 없이는 인증 미들웨어가 먼저 → JSON 401 (주소 존재 여부를 밖에 알리지 않는다)
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('B13/B5: live /api/state stays 200 when the exchange or the key fails', () => {
  it('401 / network / 429 → connected:false + exchangeError, prices intact', async () => {
    await mkLiveUser('httpu2', '91261002', 'good');
    await login('httpu2');
    exchange = () => http(401, 'unauthorized');
    let r = await call('/state');
    expect(r.status).toBe(200);
    let s = r.body as unknown as AppState;
    expect(s.connected).toBe(false);
    expect(s.exchangeError).toBe('거래소 키가 거절됐어요 (키를 다시 등록해 주세요)');
    expect(s.needsSetup).toBeUndefined();
    expect(s.wallet.equity).toBe(0);
    expect(s.positions).toEqual([]);
    expect(s.prices.BTCUSDT.last).toBe(80_000);

    exchange = () => { throw new Error('socket hang up'); };
    r = await call('/state');
    expect(r.status).toBe(200);
    expect((r.body as unknown as AppState).exchangeError).toBe('거래소 연결 실패');

    exchange = () => http(429, 'busy');
    r = await call('/state');
    expect(r.status).toBe(200);
    s = r.body as unknown as AppState;
    expect(s.exchangeError).toBe('거래소가 잠시 바빠요');
    expect(s.connected).toBe(false);
  });

  it('key row that cannot be decrypted → exchangeError (not needsSetup) and 503 KEY_DECRYPT_FAILED on trade paths', async () => {
    await mkLiveUser('httpu3', '91261003', 'broken');
    await login('httpu3');
    let r = await call('/state');
    expect(r.status).toBe(200);
    const s = r.body as unknown as AppState;
    expect(s.needsSetup).toBeUndefined();
    expect(s.connected).toBe(false);
    expect(s.exchangeError).toBe('거래소 키를 읽을 수 없어요. 관리자에게 알려 주세요');
    expect(calls.filter((p) => p.startsWith('/contract/private'))).toEqual([]);   // 거래소는 부르지 않는다

    r = await post('/order/open', { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_600 });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('KEY_DECRYPT_FAILED');
    r = await post('/position/close', { symbol: 'BTCUSDT' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('KEY_DECRYPT_FAILED');
  });
});

describe('B2/B3/B14: order path', () => {
  const order = (extra: Record<string, unknown> = {}) => post('/order/open', { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_600, ...extra });

  it('B2: same clientOrderId already in order history → answered without a new submit (duplicate:true)', async () => {
    await mkLiveUser('httpu4', '91261004', 'good');
    await login('httpu4');
    let history: unknown[] = [{ order_id: '900001', client_order_id: 'ef-dup-000001', symbol: 'BTCUSDT', side: 1, type: 'limit', size: 6, state: 4, deal_size: '6', deal_avg_price: '80010' }];
    exchange = (path) => {
      if (path === '/contract/private/order-history') return ok(history);
      if (path === '/contract/private/position-v2') return ok([]);
      return http(500, `unexpected ${path}`);
    };
    let r = await order({ clientOrderId: 'ef-dup-000001' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: true, orderId: '900001', contracts: 6, entryPrice: 80010, fillPrice: 80010, stopLossPrice: 77_600, adjusted: false });
    expect(calls.filter((p) => p === '/contract/private/submit-order')).toEqual([]);

    // 같은 표식인데 체결 없이 끝난 주문 → 409 NO_FILL + duplicate (새 표식으로 다시 내면 된다)
    history = [{ order_id: '900002', client_order_id: 'ef-dup-000002', symbol: 'BTCUSDT', side: 1, type: 'limit', size: 6, state: 4, deal_size: '0' }];
    r = await order({ clientOrderId: 'ef-dup-000002' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NO_FILL');
    expect((r.body.detail as { duplicate: boolean }).duplicate).toBe(true);
    expect(calls.filter((p) => p === '/contract/private/submit-order')).toEqual([]);

    r = await order({ clientOrderId: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_CLIENT_ORDER_ID');
  });

  it('B2/B3: fresh id is passed to the exchange; failure after submit → 409 ORDER_SENT_UNCONFIRMED', async () => {
    await mkLiveUser('httpu5', '91261005', 'good');
    await login('httpu5');
    let submitted: Record<string, unknown> | null = null;
    exchange = async (path, init) => {
      if (path === '/contract/private/order-history') return ok([]);
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === '/contract/private/submit-order') { submitted = JSON.parse(String(init?.body)); return ok({ order_id: '900010' }); }
      if (path === '/contract/private/position-v2') return submitted ? http(502, 'gateway') : ok([]);   // 주문 뒤 확인 조회만 실패
      return http(500, `unexpected ${path}`);
    };
    const r = await order({ clientOrderId: 'ef-new-000001' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORDER_SENT_UNCONFIRMED');
    expect(r.body.error).toBe('주문은 접수됐지만 체결 확인에 실패했어요. 포지션을 확인한 뒤 다시 시도해 주세요');
    expect((r.body.detail as { orderId: string }).orderId).toBe('900010');
    expect(submitted).toMatchObject({ client_order_id: 'ef-new-000001', symbol: 'BTCUSDT', side: 1, mode: 3 });
    expect(calls.filter((p) => p === '/contract/private/submit-order')).toHaveLength(1);
  });

  it('B3: close order sent but confirmation fails → 409 ORDER_SENT_UNCONFIRMED with filled', async () => {
    await mkLiveUser('httpu6', '91261006', 'good');
    await login('httpu6');
    let submitted = false;
    exchange = async (path) => {
      if (path === '/contract/private/position-v2') return submitted ? http(502, 'gateway') : ok([{ symbol: 'BTCUSDT', leverage: '5', open_type: 'isolated', current_amount: '6', position_side: 'long', open_avg_price: '80000', mark_price: '80100' }]);
      if (path === '/contract/private/submit-order') { submitted = true; return ok({ order_id: '900020' }); }
      return http(500, `unexpected ${path}`);
    };
    const r = await post('/position/close', { symbol: 'BTCUSDT' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORDER_SENT_UNCONFIRMED');
    expect(r.body.detail).toEqual({ orderId: '900020', filled: 0 });
  });

  it('B14: price older than 60s → 400 PRICE_STALE before any exchange call', async () => {
    await mkLiveUser('httpu7', '91261007', 'good');
    await login('httpu7');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const r = await order({ clientOrderId: 'ef-stale-00001' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('PRICE_STALE');
      expect(r.body.error).toBe('시세가 오래돼 주문할 수 없어요. 잠시 후 다시');
      expect(calls.filter((p) => p.startsWith('/contract/private'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
