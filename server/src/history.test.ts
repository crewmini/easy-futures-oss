import { describe, it, expect } from 'vitest';
import type { TradeHistoryItem } from '@easy-futures/shared';
import { dailyPnl, enrichHistory, kstDate, pnlByOrder, summarizeBySource } from './history.js';

let n = 0;
const T = Date.UTC(2026, 8, 7, 15, 0); // 2026-09-08 00:00 KST
function row(p: Partial<TradeHistoryItem> & { kind: TradeHistoryItem['kind']; time: number }): TradeHistoryItem {
  return { id: `t${++n}`, symbol: 'ETHUSDT', direction: 'long', contracts: 10, coinAmount: 0.01, price: 2500, pnl: p.kind === 'open' ? null : 0, fee: 0.01, leverage: 5, orderId: null, ...p };
}

describe('history enrichment', () => {
  it('cycles get source from their open orders; closes inherit; mixed when both', () => {
    const items = [
      row({ kind: 'open', time: T + 1, orderId: 'a1' }), row({ kind: 'close', time: T + 2, pnl: 1 }),               // auto 흐름
      row({ kind: 'open', time: T + 3, orderId: 'm1' }), row({ kind: 'sl', time: T + 4, pnl: -2 }),                  // manual 흐름
      row({ kind: 'open', time: T + 5, orderId: 'm2' }), row({ kind: 'open', time: T + 6, orderId: 'a2' }), row({ kind: 'close', time: T + 7, contracts: 20, pnl: 3 }), // mixed
      row({ kind: 'open', time: T + 8, orderId: 'a3' }),                                                             // 아직 열림
    ].sort((a, b) => b.time - a.time);
    enrichHistory(items, new Map([['a1', { signalId: 's1' }], ['a2', { signalId: 's2' }], ['a3', { signalId: 's3' }]]));
    const by = Object.fromEntries(items.map((i) => [i.orderId ?? `${i.kind}@${i.time - T}`, i.source]));
    expect(by).toEqual({ a1: 'auto', 'close@2': 'auto', m1: 'manual', 'sl@4': 'manual', m2: 'mixed', a2: 'mixed', 'close@7': 'mixed', a3: 'auto' });
    expect(items.find((i) => i.orderId === 'a1')?.signalId).toBe('s1');
    const close2 = items.find((i) => i.time === T + 7)!;
    expect(close2.openFee).toBeCloseTo(0.02, 4); expect(close2.netPnl).toBeCloseTo(3 - 0.02 - 0.01, 4);
    const s = summarizeBySource(items);
    expect(s.auto.closedCount).toBe(2); expect(s.manual.closedCount).toBe(1);
    expect(s.auto.netPnl).toBeCloseTo(1 + 3 - 0.01 * 6, 2); expect(s.manual.netPnl).toBeCloseTo(-2 - 0.02, 2);
  });
  it('close without a known open still gets a manual cycle', () => {
    const items = [row({ kind: 'close', time: T + 1, pnl: 5 })];
    enrichHistory(items);
    expect(items[0].source).toBe('manual'); expect(items[0].netPnl).toBeCloseTo(5 - 0.01, 4);
  });
  it('daily pnl in KST with auto/manual split', () => {
    const items = [
      row({ kind: 'open', time: T - 3_600_000, orderId: 'a1' }), row({ kind: 'close', time: T - 1000, pnl: 2 }),   // 9/7 KST
      row({ kind: 'open', time: T + 1000, orderId: 'm1' }), row({ kind: 'tp', time: T + 2000, pnl: 4 }),            // 9/8 KST
    ];
    enrichHistory(items, new Map([['a1', { signalId: 's' }]]));
    const d = dailyPnl(items);
    expect(d.map((x) => x.date)).toEqual(['2026-09-08', '2026-09-07']);
    expect(d[1]).toMatchObject({ closedCount: 1, auto: 2 - 0.02, manual: 0 });
    expect(d[0].manual).toBeCloseTo(4 - 0.02, 4); expect(d[0].netPnl).toBeCloseTo(4 - 0.02, 4);
    expect(kstDate(Date.UTC(2026, 8, 7, 14, 59))).toBe('2026-09-07');
  });
  it('pnlByOrder maps entry orders to their cycle result', () => {
    const items = [
      row({ kind: 'open', time: T + 1, orderId: 'a1' }), row({ kind: 'open', time: T + 2, orderId: 'a2' }), row({ kind: 'close', time: T + 3, contracts: 20, pnl: 6 }),
      row({ kind: 'open', time: T + 4, orderId: 'a3' }),
    ];
    enrichHistory(items);
    const m = pnlByOrder(items);
    expect(m.get('a1')?.closed).toBe(true); expect(m.get('a1')?.pnl).toBeCloseTo(6 - 0.02 - 0.01, 4); expect(m.get('a2')).toEqual(m.get('a1'));
    expect(m.get('a3')).toEqual({ pnl: null, closed: false });
  });
});

describe('출처 판정 — 카피 주문 표식·혼합 규칙 (2026-09-28 실사례)', () => {
  const row = (o: Partial<TradeHistoryItem> & { time: number; kind: TradeHistoryItem['kind'] }): TradeHistoryItem => ({
    id: `t${o.time}`, symbol: 'BTCUSDT', direction: 'long', contracts: 10, coinAmount: 0.01, price: 80_000, pnl: o.kind === 'open' ? null : 5, fee: 0.1, leverage: 20, orderId: null, ...o,
  });
  it('기록에 주문 id 가 없어도 주문 표식이 cp… 이면 고수 따라하기', () => {
    const items = enrichHistory([row({ time: 1, kind: 'open', orderId: '111', clientOrderId: 'cp583s105f590' }), row({ time: 2, kind: 'close', orderId: '112', clientOrderId: 'cp583L590t1' })]);
    expect(items.map((i) => i.source)).toEqual(['copy', 'copy']);
    const by = summarizeBySource(items);
    expect(by.copy.closedCount).toBe(1); expect(by.auto.closedCount).toBe(0); expect(by.manual.closedCount).toBe(0);
  });
  it('카피 + 직접(표식 없음)이 섞인 흐름은 자동매매가 아니라 고수 따라하기, 자동매매가 낀 흐름만 혼합', () => {
    const a = enrichHistory([row({ time: 1, kind: 'open', orderId: '1', clientOrderId: 'cp583s1f5' }), row({ time: 2, kind: 'open', orderId: '2' }), row({ time: 3, kind: 'close', orderId: '3', contracts: 20 })]);
    expect(a[2].source).toBe('copy');
    const tags = new Map([['9', { signalId: 'sig' }]]);
    const b = enrichHistory([row({ time: 1, kind: 'open', orderId: '9' }), row({ time: 2, kind: 'open', orderId: '2', clientOrderId: 'cp583s2f5' }), row({ time: 3, kind: 'close', orderId: '3', contracts: 20 })], tags);
    expect(b[2].source).toBe('mixed');
    expect(summarizeBySource(b).auto.closedCount).toBe(1);
  });
});
