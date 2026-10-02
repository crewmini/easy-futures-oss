// WooxClient.request 안정성 (감사 B1): 본문도 타임아웃 안에서 읽는다, 429 는 retryAfterMs 를 싣는다
import { describe, it, expect } from 'vitest';
import { retryAfterFromHeaders, WooxClient, WooxError } from './client.js';

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('WooxClient.request', () => {
  it('header arrives but body never does → NETWORK within the deadline (not forever)', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() { /* 절대 enqueue/close 하지 않는다 */ } });
    const client = new WooxClient({ timeoutMs: 80, fetchImpl: async () => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } }) });
    const t0 = Date.now();
    const err = await client.getContractDetails().then(() => null, (e) => e as WooxError);
    expect(err).toBeInstanceOf(WooxError);
    expect(err!.code).toBe('NETWORK');
    expect(err!.message).toBe('네트워크 오류: 응답 본문 시간 초과');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('fetch itself failing keeps the network mapping', async () => {
    const client = new WooxClient({ fetchImpl: async () => { throw new Error('boom'); } });
    const err = await client.getContractDetails().then(() => null, (e) => e as WooxError);
    expect(err?.code).toBe('NETWORK');
    expect(err?.message).toBe('네트워크 오류: boom');
  });

  it('429 carries retryAfterMs from Retry-After (seconds)', async () => {
    const client = new WooxClient({ fetchImpl: async () => json({ code: 30007, message: 'busy' }, { status: 429, headers: { 'retry-after': '7' } }) });
    const err = await client.getContractDetails().then(() => null, (e) => e as WooxError);
    expect(err?.httpStatus).toBe(429);
    expect(err?.code).toBe('RATE_LIMITED');
    expect(err?.retryAfterMs).toBe(7000);
  });

  it('retryAfterFromHeaders: Retry-After → x-bm-ratelimit-reset → 5000', () => {
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterFromHeaders(new Headers({ 'x-bm-ratelimit-reset': '12' }))).toBe(12000);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': 'garbage' }))).toBe(5000);
    expect(retryAfterFromHeaders(new Headers())).toBe(5000);
  });

  it('normal envelope still parses and the timer is cleared', async () => {
    const client = new WooxClient({ timeoutMs: 1000, fetchImpl: async () => json({ code: 1000, message: 'Ok', data: { symbols: [{ symbol: 'BTCUSDT', contract_size: '0.001', price_precision: '0.1', vol_precision: '1', min_volume: '1', max_leverage: '200', index_price: '80000' }] } }) });
    const list = await client.getContractDetails();
    expect(list).toHaveLength(1);
    expect(list[0].index_price).toBe('80000');
  });
});


describe('per-key rate-limit throttle', () => {
  it('waits for the window to reset when the last response says the key window is nearly used', async () => {
    const calls: number[] = [];
    let n = 0;
    const fetchImpl = async () => {
      n++; calls.push(Date.now());
      const used = n === 1 ? 5 : 1;   // 첫 응답: 6회 중 5회 사용 → 다음 호출은 창이 끝날 때까지 기다려야 한다
      return new Response(JSON.stringify({ code: 1000, message: 'ok', data: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-bm-ratelimit-limit': '6', 'x-bm-ratelimit-remaining': String(used), 'x-bm-ratelimit-reset': '1', 'x-bm-ratelimit-mode': 'KEY' } });
    };
    const c = new WooxClient({ credentials: { apiKey: 'k', apiSecret: 's', memo: 'm' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.getPositionsV2();
    const t0 = Date.now();
    await c.getPositionsV2();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // 창이 지난 뒤(사용 1회)에는 기다리지 않는다
    const t1 = Date.now();
    await c.getPositionsV2();
    expect(Date.now() - t1).toBeLessThan(300);
    expect(calls.length).toBe(3);
  });
});
