// 라우트 통합 테스트 (workerd 안에서 실행, 실제 네트워크 없음): 가입 → 로그인 → 상태(연습) → 주문 → 정리
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { AppState } from '@easy-futures/shared';

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

/** 시세 피드가 꺼져 있으므로 DO 에 직접 시세를 주입한다. */
async function injectPrices() {
  const id = env.PAPER.idFromName('global');
  const stub = env.PAPER.get(id);
  await stub.fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }) });
}

describe('api routes', () => {
  it('health is public', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('state without cookie → 401', async () => {
    const r = await call('/state');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('로그인이 필요해요');
  });

  it('signup → login → state → open → close', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'test1', password: '123456', inviteCode: 'nope', uid: '91231234', termsAgreed: true, termsVersion: '2026-09-07' }) });
    expect(r.status).toBe(400);

    r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'nocode1', password: '123456', uid: '91231299', termsAgreed: true, termsVersion: '2026-09-07' }) });
    expect(r.status).toBe(200); // 가입 코드 없이도 가입
    cookie = '';
    r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'test1', password: '123456', inviteCode: 'dev1234', uid: '91231234', termsAgreed: true, termsVersion: '2026-09-07' }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ loginId: 'test1', hasApiKey: false, apiKeyPreview: null, mode: 'paper', uid: '91231234', kycStatus: 'none', kycNote: null });
    expect(cookie).toMatch(/^ef_session=/);

    r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'test1', password: '123456', inviteCode: 'dev1234', uid: '91231234', termsAgreed: true, termsVersion: '2026-09-07' }) });
    expect(r.status).toBe(409);

    cookie = '';
    r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'test1', password: 'wrong1' }) });
    expect(r.status).toBe(401);
    r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'test1', password: '123456' }) });
    expect(r.status).toBe(200);
    expect(cookie).toMatch(/^ef_session=/);

    await injectPrices();
    r = await call('/state');
    expect(r.status).toBe(200);
    const s = r.body as unknown as AppState;
    expect(s.mode).toBe('paper');
    expect(s.wallet.available).toBe(1000);
    expect(s.positions).toEqual([]);
    expect(s.prices.BTCUSDT.last).toBe(80_000);
    expect(s.contracts.BTCUSDT.contractSize).toBeGreaterThan(0);
    expect(s.connected).toBe(true);

    r = await call('/order/open', { method: 'POST', body: JSON.stringify({ symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 81_000 }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('손절가는 지금 가격보다 낮아야 해요');

    r = await call('/order/open', { method: 'POST', body: JSON.stringify({ symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_600 }) });
    expect(r.status).toBe(200);
    expect(r.body.contracts).toBe(6);
    expect(r.body.entryPrice).toBe(80_000);

    r = await call('/state');
    const s2 = r.body as unknown as AppState;
    expect(s2.positions).toHaveLength(1);
    expect(s2.positions[0].direction).toBe('long');
    expect(s2.positions[0].stopLossPrice).toBe(77_600);
    expect(s2.wallet.available).toBeLessThan(1000);

    r = await call('/position/tpsl', { method: 'POST', body: JSON.stringify({ symbol: 'BTCUSDT', takeProfitPrice: 90_000 }) });
    expect(r.status).toBe(200);

    r = await call('/position/close', { method: 'POST', body: JSON.stringify({ symbol: 'BTCUSDT' }) });
    expect(r.status).toBe(200);
    r = await call('/state');
    expect((r.body as unknown as AppState).positions).toEqual([]);

    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'live' }) });
    expect(r.status).toBe(400);

    r = await call('/auth/logout', { method: 'POST' });
    expect(r.status).toBe(200);
    r = await call('/state');
    expect(r.status).toBe(401);
  });
});
