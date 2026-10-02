// hlbot tests/test_{pivots,counting,bottom,timeframes}.py 이식 — 같은 입력에 같은 결과
import { describe, it, expect } from 'vitest';
import { BOTTOM_WINDOW, MIN_BARS_AFTER_BOTTOM, SUPPORTED_TFS, bottomBandPct, closedOnly, decide, ema, findPivotLows, intervalMs, isRetestLow, type Candle, type ChainEntry } from './strategy.js';

const STEP = 15 * 60_000;
const T0 = Date.UTC(2026, 5, 1);
function mk(lows: number[], vols?: number[]): Candle[] {
  return lows.map((x, i) => ({ t: T0 + i * STEP, o: x + 5, h: x + 10, l: x, c: x + 5, v: vols ? vols[i] : 1 }));
}

describe('pivots', () => {
  it('finds v bottom', () => expect(findPivotLows(mk([100, 99, 98, 95, 97, 99, 100]))).toEqual([3]));
  it('flat series has no pivot', () => expect(findPivotLows(mk(Array(20).fill(100)))).toEqual([]));
  it('edges excluded', () => expect(findPivotLows(mk([100, 99, 98, 97, 96, 95, 94]))).toEqual([]));
  it('equal lows counted once', () => expect(findPivotLows(mk([100, 99, 98, 95, 97, 95, 97, 99, 100]))).toEqual([3]));
  it('multiple pivots', () => expect(findPivotLows(mk([100, 97, 100, 100, 100, 100, 96, 100, 100, 100, 100, 95, 100, 100, 100]))).toEqual([6, 11]));
});

describe('counting (3의 법칙)', () => {
  const e = (seq: number, low: number): ChainEntry => ({ seq, tsMs: seq * 100_000, low, status: 'proposed' });
  const c = (low: number) => ({ tsMs: 1_000_000, low });
  it('empty chain proposes 1', () => expect(decide([], c(100), 999)).toEqual({ action: 'propose', seq: 1 }));
  it('higher low proposes 2', () => expect(decide([e(1, 100)], c(105), 15)).toEqual({ action: 'propose', seq: 2 }));
  it('higher low proposes 3', () => expect(decide([e(1, 100), e(2, 105)], c(107), 15)).toEqual({ action: 'propose', seq: 3 }));
  it('lower than anchor proposes reanchor', () => expect(decide([e(1, 100), e(2, 105)], c(98), 15)).toEqual({ action: 'propose_reanchor', seq: 1 }));
  it('between anchor and last ignored', () => expect(decide([e(1, 100), e(2, 105)], c(102), 15)).toEqual({ action: 'none', seq: null }));
  it('complete chain ignores', () => expect(decide([e(1, 100), e(2, 105), e(3, 107)], c(110), 15)).toEqual({ action: 'none', seq: null }));
  it('complete chain still reanchors', () => expect(decide([e(1, 100), e(2, 105), e(3, 107)], c(95), 15)).toEqual({ action: 'propose_reanchor', seq: 1 }));
  it('min gap blocks proposal', () => expect(decide([e(1, 100)], c(105), 3)).toEqual({ action: 'none', seq: null }));
  it('min gap does not block reanchor', () => expect(decide([e(1, 100)], c(98), 3)).toEqual({ action: 'propose_reanchor', seq: 1 }));
  it('equal low counts as higher (동저점)', () => expect(decide([e(1, 100)], c(100), 15)).toEqual({ action: 'propose', seq: 2 }));
});

describe('bottom retest (1번 정의)', () => {
  it('band scales with sqrt(tf), capped at 10', () => {
    expect(bottomBandPct('15m')).toBeCloseTo(3.0);
    expect(bottomBandPct('1h')).toBeCloseTo(6.0);
    expect(bottomBandPct('4h')).toBeCloseTo(10.0);
    expect(bottomBandPct('1d')).toBeCloseTo(10.0);
  });
  it('retest after bottom passes', () => { const l = Array(240).fill(100); l[200] = 89; l[234] = 90; expect(isRetestLow(mk(l), 234, '15m')).toBe(true); });
  it('fresh new low rejected', () => { const l = Array(240).fill(100); l[234] = 90; expect(isRetestLow(mk(l), 234, '15m')).toBe(false); });
  it('too soon without bounce rejected', () => {
    const l = Array(240).fill(100); l[225] = 89; l[234] = 89.3;
    const k = mk(l); for (let i = 225; i < 235; i++) k[i].h = 90;
    expect(isRetestLow(k, 234, '15m')).toBe(false); expect(234 - 225).toBeLessThan(MIN_BARS_AFTER_BOTTOM);
  });
  it('early retest with real bounce passes', () => {
    const l = Array(240).fill(100); l[225] = 89; l[234] = 89.3;
    const k = mk(l); for (let i = 225; i < 235; i++) k[i].h = 90; k[229].h = 92;
    expect(isRetestLow(k, 234, '15m')).toBe(true);
  });
  it('immediately after bottom rejected', () => { const l = Array(240).fill(100); l[231] = 89; l[234] = 89.3; expect(isRetestLow(mk(l), 234, '15m')).toBe(false); });
  it('far above bottom rejected', () => { const l = Array(240).fill(100); l[120] = 80; l[234] = 90; expect(isRetestLow(mk(l), 234, '15m')).toBe(false); });
  it('slight undercut passes', () => { const l = Array(240).fill(100); l[200] = 90; l[234] = 89.8; expect(isRetestLow(mk(l), 234, '15m')).toBe(true); });
  it('deeper undercut rejected', () => { const l = Array(240).fill(100); l[200] = 90; l[234] = 89; expect(isRetestLow(mk(l), 234, '15m')).toBe(false); });
  it('insufficient history rejected', () => { expect(isRetestLow(mk(Array(100).fill(100)), 90, '15m')).toBe(false); expect(BOTTOM_WINDOW).toBeGreaterThan(100); });
  it('bottom on window edge rejected', () => { const l = Array(240).fill(100); l[234 - BOTTOM_WINDOW] = 89; l[234] = 90; expect(isRetestLow(mk(l), 234, '15m')).toBe(false); });
});

describe('timeframes / ema / closedOnly', () => {
  it('supported range 5m~1M', () => { for (const tf of ['5m', '15m', '1h', '4h', '1d', '1M']) expect(SUPPORTED_TFS).toContain(tf); expect(SUPPORTED_TFS).not.toContain('1m'); });
  it('interval ms', () => { expect(intervalMs('5m')).toBe(300_000); expect(intervalMs('1d')).toBe(86_400_000); expect(() => intervalMs('7m')).toThrow('지원하지 않는 타임프레임'); });
  it('ema matches pandas adjust=False recursion', () => {
    const e = ema([1, 2, 3, 4, 5], 3); // alpha 0.5
    expect(e).toEqual([1, 1.5, 2.25, 3.125, 4.0625]);
  });
  it('closedOnly keeps bars whose close time has passed', () => {
    const k = mk([1, 2, 3]);
    expect(closedOnly(k, '15m', T0 + 2 * STEP + 1).length).toBe(2);
    expect(closedOnly(k, '15m', T0 + 3 * STEP).length).toBe(3);
  });
});
