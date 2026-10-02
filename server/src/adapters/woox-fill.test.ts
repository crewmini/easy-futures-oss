// 실거래 어댑터 체결 확인 (2026-09-22): 주문 1건 조회(getOrder)로 확정하고 포지션은 한 번만 읽는다 — 팬아웃 429 완화.
// 거래소는 WooxClient 의 fetchImpl 로 흉내낸다 (http-layer.test 의 전역 fetch 가로채기와 같은 응답 모양)
import { describe, it, expect } from 'vitest';
import type { OpenOrderRequest } from '@easy-futures/shared';
import { FALLBACK_CONTRACTS } from '../market.js';
import { HttpError } from '../errors.js';
import { WooxClient } from '../woox/client.js';
import { positionModeOf, WooxAdapter } from './woox.js';

const BTC = FALLBACK_CONTRACTS.BTCUSDT;
const ok = (data: unknown) => Response.json({ code: 1000, message: 'Ok', data });
const http = (status: number, message = 'err', headers: Record<string, string> = {}) => Response.json({ code: status, message }, { status, headers });
type Handler = (path: string, query: URLSearchParams, init?: RequestInit) => Response | Promise<Response>;

function harness(handler: Handler) {
  const calls: string[] = [];
  const client = new WooxClient({
    credentials: { apiKey: 'k', apiSecret: 's', memo: 'm' },
    fetchImpl: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      calls.push(url.pathname);
      return handler(url.pathname, url.searchParams, init);
    },
  });
  return { adapter: new WooxAdapter(client), calls, count: (p: string) => calls.filter((c) => c === p).length };
}
const pos = (amount: number, avg = 80_000, extra: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', leverage: '5', open_type: 'isolated', current_amount: String(amount), position_side: 'long', open_avg_price: String(avg), mark_price: '80100', ...extra });
const REQ: OpenOrderRequest = { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 16, leverage: 5, stopLossPrice: 76_000, takeProfitPrice: null };
const P = { order: '/contract/private/order', position: '/contract/private/position-v2', submit: '/contract/private/submit-order' };

describe('WooxAdapter.openOrder — 체결 확인은 주문 조회로', () => {
  it('주문 조회에 체결이 보이면 포지션은 한 번만 읽고 체결가는 deal_avg_price', async () => {
    let submitted = false;
    const h = harness((path) => {
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === P.submit) { submitted = true; return ok({ order_id: '1001' }); }
      if (path === P.order) return ok({ order_id: '1001', state: 4, deal_size: '1', deal_avg_price: '80010' });
      if (path === P.position) return ok(submitted ? [pos(1)] : []);
      if (path === '/contract/private/current-plan-order') return ok([]);
      return http(500, `unexpected ${path}`);
    });
    const r = await h.adapter.openOrder(REQ, 1, BTC, 80_000, { clientOrderId: 'fill0001' });
    expect(r).toMatchObject({ orderId: '1001', contracts: 1, entryPrice: 80_000, fillPrice: 80_010, stopLossPrice: 76_000 });
    expect(h.count(P.order)).toBe(1);
    expect(h.count(P.position)).toBe(2);   // 주문 전 1 + 확인 1 (예전: 주문 전 1 + 폴링 최대 10 + 손절 정렬 최대 10)
  });

  it('IOC 가 하나도 안 잡혀 종료(state 4, deal_size 0)면 NO_FILL — 포지션 1회 확인, 추가 조회 없음', async () => {
    const h = harness((path) => {
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === P.submit) return ok({ order_id: '1002' });
      if (path === P.order) return ok({ order_id: '1002', state: 4, deal_size: '0' });
      if (path === P.position) return ok([]);
      return http(500, `unexpected ${path}`);
    });
    const err = await h.adapter.openOrder(REQ, 1, BTC, 80_000).then(() => null, (e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.code).toBe('NO_FILL');
    expect(err!.detail).toEqual({ orderId: '1002' });
    expect(h.count(P.order)).toBe(1);
    expect(h.count(P.position)).toBe(2);
  });

  it('주문 조회가 429 면 Retry-After 뒤 한 번 다시 (그 뒤 체결 확인)', async () => {
    let orderCalls = 0;
    let submitted = false;
    const h = harness((path) => {
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === P.submit) { submitted = true; return ok({ order_id: '1003' }); }
      if (path === P.order) return ++orderCalls === 1 ? http(429, 'busy', { 'retry-after': '0.3' }) : ok({ order_id: '1003', state: 4, deal_size: '1', deal_avg_price: '80005' });
      if (path === P.position) return ok(submitted ? [pos(1)] : []);
      if (path === '/contract/private/current-plan-order') return ok([]);
      return http(500, `unexpected ${path}`);
    });
    const t0 = Date.now();
    const r = await h.adapter.openOrder(REQ, 1, BTC, 80_000);
    expect(r).toMatchObject({ contracts: 1, fillPrice: 80_005 });
    expect(h.count(P.order)).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);   // 250ms 첫 조회 + 300ms 대기
  });

  it('주문 조회가 실패하면(500) 포지션 폴링으로 폴백 — 늘어난 수량으로 체결 판정', async () => {
    let submitted = false;
    let posReads = 0;
    const h = harness((path) => {
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === P.submit) { submitted = true; return ok({ order_id: '1004' }); }
      if (path === P.order) return http(500, 'no such endpoint');
      if (path === P.position) { if (submitted) posReads++; return ok(submitted && posReads >= 2 ? [pos(1, 80_020)] : []); }   // 두 번째 폴링에야 보인다
      if (path === '/contract/private/current-plan-order') return ok([]);
      return http(500, `unexpected ${path}`);
    });
    const r = await h.adapter.openOrder(REQ, 1, BTC, 80_000);
    expect(r).toMatchObject({ contracts: 1, entryPrice: 80_020, fillPrice: 80_020 });
    expect(h.count(P.order)).toBe(1);   // 첫 조회 실패 → 바로 폴백 (남은 3번은 낭비하지 않는다)
    expect(posReads).toBe(2);
  });

  it('주문 접수 뒤 포지션 조회까지 실패하면 ORDER_SENT_UNCONFIRMED (재시도로 두 번 진입하지 않게)', async () => {
    let submitted = false;
    const h = harness((path) => {
      if (path === '/contract/private/submit-leverage') return ok({});
      if (path === P.submit) { submitted = true; return ok({ order_id: '1005' }); }
      if (path === P.position) return submitted ? http(502, 'gateway') : ok([]);
      return http(500, `unexpected ${path}`);
    });
    const err = await h.adapter.openOrder(REQ, 1, BTC, 80_000).then(() => null, (e) => e as HttpError);
    expect(err?.code).toBe('ORDER_SENT_UNCONFIRMED');
    expect(err?.detail).toEqual({ orderId: '1005' });
  });
});

describe('WooxAdapter.reducePosition / closePosition — 정리 체결 확인', () => {
  it('부분 정리: 주문 조회로 2계약 체결 확인, 포지션 반영이 늦어도 같은 물량을 두 번 내지 않는다', async () => {
    let submits = 0;
    const h = harness((path) => {
      if (path === P.submit) { submits++; return ok({ order_id: `2${submits}` }); }
      if (path === P.order) return ok({ order_id: '21', state: 4, deal_size: '2', deal_avg_price: '80100' });
      if (path === P.position) return ok([pos(6)]);   // 아직 6 으로 보임 (반영 지연)
      return http(500, `unexpected ${path}`);
    });
    const r = await h.adapter.reducePosition('BTCUSDT', 2, BTC, { clientOrderId: 'red00001' });
    expect(r).toMatchObject({ contracts: 2 });
    expect(submits).toBe(1);
    expect(h.count(P.order)).toBe(1);
    expect(h.count(P.position)).toBe(2);   // 정리 전 1 + 확인 1
  });

  it('전량 정리: 포지션이 0 이 되면 남은 플랜 주문 취소, 조회 실패(429 두 번)면 포지션 폴링으로', async () => {
    let submitted = false;
    let cancelled = 0;
    const h = harness((path) => {
      if (path === P.submit) { submitted = true; return ok({ order_id: '31' }); }
      if (path === P.order) return http(429, 'busy', { 'retry-after': '0.2' });
      if (path === P.position) return ok(submitted ? [] : [pos(3)]);
      if (path === '/contract/private/current-plan-order') return ok([{ order_id: 'p1', symbol: 'BTCUSDT', side: 3, type: 'stop_loss', trigger_price: '76000', price_type: 2 }]);
      if (path === '/contract/private/cancel-plan-order') { cancelled++; return ok({}); }
      return http(500, `unexpected ${path}`);
    });
    const r = await h.adapter.closePosition('BTCUSDT', BTC);
    expect(r).toMatchObject({ contracts: 3 });
    expect(h.count(P.order)).toBe(2);   // 429 → 한 번 재시도 → 포기(폴백)
    expect(cancelled).toBe(1);
  });

  it('정리 주문 접수 뒤 확인이 모두 실패하면 ORDER_SENT_UNCONFIRMED + filled 0', async () => {
    let submitted = false;
    const h = harness((path) => {
      if (path === P.submit) { submitted = true; return ok({ order_id: '41' }); }
      if (path === P.position) return submitted ? http(502, 'gateway') : ok([pos(6)]);
      return http(500, `unexpected ${path}`);
    });
    const err = await h.adapter.closePosition('BTCUSDT', BTC).then(() => null, (e) => e as HttpError);
    expect(err?.code).toBe('ORDER_SENT_UNCONFIRMED');
    expect(err?.detail).toEqual({ orderId: '41', filled: 0 });
  });
});

describe('positionModeOf / getAccount.positionMode', () => {
  it('position-v2 행의 position_mode 로 추정, 없으면 unknown', () => {
    expect(positionModeOf([])).toBe('unknown');
    expect(positionModeOf([pos(1)])).toBe('unknown');
    expect(positionModeOf([pos(1, 80_000, { position_mode: 'one_way_mode' })])).toBe('one_way');
    expect(positionModeOf([pos(1, 80_000, { position_mode: 'hedge_mode' })])).toBe('hedge');
  });
  it('getAccount 결과에 positionMode 가 실린다', async () => {
    const h = harness((path) => {
      if (path === '/contract/private/assets-detail') return ok([{ currency: 'USDT', available_balance: '100', equity: '120', unrealized: '0', position_deposit: '20' }]);
      if (path === P.position) return ok([pos(1, 80_000, { position_mode: 'hedge_mode' })]);
      if (path === '/contract/private/current-plan-order') return ok([]);
      return http(500, `unexpected ${path}`);
    });
    const acc = await h.adapter.getAccount(FALLBACK_CONTRACTS, {});
    expect(acc.positionMode).toBe('hedge');
    expect(acc.positions).toHaveLength(1);
  });
});


describe('closeLimitPrice — 정리 지정가는 강제정리 가격 안쪽', () => {
  const C = { symbol: 'BTCUSDT', contractSize: 0.001, pricePrecision: 0.1, volPrecision: 1, minVolume: 1, maxLeverage: 100 } as never;
  it('숏 정리(매수): 현재가+1% 가 강제정리가를 넘으면 강제정리가 바로 아래로', async () => {
    const { closeLimitPrice } = await import('./woox.js');
    // 평단 85,966 숏 40배, 현재가 86,750, 강제정리 87,600 → +1% = 87,617.5 는 바깥 → 87,556.2 로
    expect(Number(closeLimitPrice(86_750, 'short', 0.01, 87_600, C))).toBeCloseTo(87_556.2, 1);
    // 강제정리가 멀면 그대로 +1%
    expect(Number(closeLimitPrice(86_750, 'short', 0.01, 95_000, C))).toBeCloseTo(87_617.5, 1);
  });
  it('롱 정리(매도): 현재가-1% 가 강제정리가 아래면 강제정리가 바로 위로, 정보 없으면 그대로', async () => {
    const { closeLimitPrice } = await import('./woox.js');
    expect(Number(closeLimitPrice(84_000, 'long', 0.01, 83_500, C))).toBeCloseTo(83_541.8, 1);
    expect(Number(closeLimitPrice(84_000, 'long', 0.01, 0, C))).toBeCloseTo(83_160, 1);
  });
});
