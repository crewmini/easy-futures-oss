// 거래 내역 출처 판정 통합: 직접 주문(쉬운 거래) 흐름은 manual, 자동매매 신호로 연 흐름은 auto, 실행 기록에는 손익이 붙는다
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { AUTO_TERMS_VERSION, TERMS_VERSION, type AutoStateResponse, type TradeHistoryResponse } from '@easy-futures/shared';
import { insertSignal } from '../auto/db.js';

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
async function prices(p: Record<string, number>) { await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) }); }

describe('history sources', () => {
  it('manual vs auto cycles, daily pnl, execution pnl', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'srcuser', password: '123456', inviteCode: 'dev1234', uid: '91233333', termsAgreed: true, termsVersion: TERMS_VERSION }) });
    expect(r.status).toBe(200);
    const userId = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'srcuser'").first<{ id: number }>())!.id;
    await prices({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 });
    // 1) 직접 진입 → 정리 (쉬운 거래 흐름)
    r = await call('/order/open', { method: 'POST', body: JSON.stringify({ symbol: 'ETHUSDT', direction: 'long', amountUsdt: 50, leverage: 5, stopLossPrice: 2_400 }) });
    expect(r.status).toBe(200);
    await prices({ BTCUSDT: 80_000, ETHUSDT: 2_600, SOLUSDT: 100 });
    r = await call('/position/close', { method: 'POST', body: JSON.stringify({ symbol: 'ETHUSDT' }) });
    expect(r.status).toBe(200);
    // 2) 자동매매 승인+켬 → 신호로 진입 → 정리 (자동매매 흐름)
    await env.DB.prepare("UPDATE users SET kyc_status = 'approved', auto_status = 'approved' WHERE id = ?").bind(userId).run();
    await env.DB.prepare("INSERT INTO auto_settings (user_id, enabled, pct, max_leverage, default_sl_roi, agreed_at, applied_at, updated_at, auto_terms_version) VALUES (?, 1, 30, 5, 20, 1, 1, 1, ?)").bind(userId, AUTO_TERMS_VERSION).run();
    const stub = env.AUTO.get(env.AUTO.idFromName('global'));
    const base = { source: 'bot' as const, symbol: 'ETHUSDT' as const, leverage: 3, slRoi: null, tpRoi: null, slPrice: null, tpPrice: null, breakeven: false, note: '테스트', createdAt: Date.now(), processedAt: null, followerCount: null, okCount: null, failCount: null };
    await insertSignal(env.DB, { ...base, id: 'sig-open-1', action: 'open', direction: 'long' });
    let run = (await (await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: 'sig-open-1' }), headers: { 'content-type': 'application/json' } })).json()) as { ok: number };
    expect(run.ok).toBe(1);
    await prices({ BTCUSDT: 80_000, ETHUSDT: 2_550, SOLUSDT: 100 }); // 손절(약 2,427)보다 위, 진입(2,600)보다 아래 → 정리 신호로 손실 확정
    await insertSignal(env.DB, { ...base, id: 'sig-close-1', action: 'close', direction: null, createdAt: Date.now() + 1 });
    run = (await (await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: 'sig-close-1' }), headers: { 'content-type': 'application/json' } })).json()) as { ok: number };
    expect(run.ok).toBe(1);

    r = await call('/history?days=7');
    const h = r.body as unknown as TradeHistoryResponse;
    const closes = h.items.filter((i) => i.kind !== 'open').sort((a, b) => a.time - b.time);
    expect(closes.map((i) => i.source)).toEqual(['manual', 'auto']);
    expect(h.items.filter((i) => i.kind === 'open').map((i) => i.source).sort()).toEqual(['auto', 'manual']);
    expect(h.items.find((i) => i.source === 'auto' && i.kind === 'open')?.signalId).toBe('sig-open-1');
    expect(h.bySource.manual.closedCount).toBe(1); expect(h.bySource.auto.closedCount).toBe(1);
    expect(h.bySource.manual.netPnl).toBeGreaterThan(0); expect(h.bySource.auto.netPnl).toBeLessThan(0);
    expect(h.netPnl).toBeCloseTo(h.bySource.manual.netPnl + h.bySource.auto.netPnl, 1);
    expect(h.daily).toHaveLength(1); expect(h.daily[0].closedCount).toBe(2); expect(h.daily[0].auto).toBeLessThan(0); expect(h.daily[0].manual).toBeGreaterThan(0);

    r = await call('/auto');
    const a = r.body as unknown as AutoStateResponse;
    const openExec = a.myExecutions.find((e) => e.signalId === 'sig-open-1')!;
    expect(openExec.orderId).toMatch(/^paper-/);
    expect(openExec.closed).toBe(true); expect(openExec.pnl).toBeLessThan(0);
  });
});
