import { describe, it, expect } from 'vitest';
import type { Settings } from '@easy-futures/shared';
import { validateOpenOrder, validateSettings, validateTpSl, validateLoginId, validatePassword } from './validate.js';

const S: Settings = { mode: 'paper', maxLeverage: 10, maxAmountUsdt: 500, usdtKrw: 1380 };
const base = { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_000 };

describe('validateOpenOrder', () => {
  it('accepts a valid long order', () => {
    const r = validateOpenOrder({ ...base, takeProfitPrice: 85_000 }, S, 80_000);
    expect(r).toEqual({ symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_000, takeProfitPrice: 85_000, stopLossRoiPct: null, takeProfitRoiPct: null });
  });
  it('keeps ROI percents when valid and drops invalid ones', () => {
    const ok = validateOpenOrder({ ...base, stopLossRoiPct: 20, takeProfitRoiPct: 50 }, S, 80_000);
    expect(ok.stopLossRoiPct).toBe(20);
    expect(ok.takeProfitRoiPct).toBe(50);
    const bad = validateOpenOrder({ ...base, stopLossRoiPct: 150, takeProfitRoiPct: -5 }, S, 80_000);
    expect(bad.stopLossRoiPct).toBeNull();
    expect(bad.takeProfitRoiPct).toBeNull();
  });
  it('rejects SL on the wrong side (long)', () => {
    expect(() => validateOpenOrder({ ...base, stopLossPrice: 81_000 }, S, 80_000)).toThrow('손절가는 지금 가격보다 낮아야 해요');
  });
  it('rejects SL on the wrong side (short)', () => {
    expect(() => validateOpenOrder({ ...base, direction: 'short', stopLossPrice: 79_000 }, S, 80_000)).toThrow('손절가는 지금 가격보다 높아야 해요');
  });
  it('requires SL', () => {
    expect(() => validateOpenOrder({ ...base, stopLossPrice: undefined }, S, 80_000)).toThrow('손절가는 꼭 넣어야 해요');
  });
  it('rejects TP on the wrong side', () => {
    expect(() => validateOpenOrder({ ...base, takeProfitPrice: 79_000 }, S, 80_000)).toThrow('익절가는 지금 가격보다 높아야 해요');
    expect(() => validateOpenOrder({ ...base, direction: 'short', stopLossPrice: 82_000, takeProfitPrice: 81_000 }, S, 80_000)).toThrow('익절가는 지금 가격보다 낮아야 해요');
  });
  it('rejects leverage outside [1, maxLeverage]', () => {
    expect(() => validateOpenOrder({ ...base, leverage: 11 }, S, 80_000)).toThrow('배율은 1배부터 10배까지만 가능해요');
    expect(() => validateOpenOrder({ ...base, leverage: 0 }, S, 80_000)).toThrow(/배율/);
    expect(() => validateOpenOrder({ ...base, leverage: 2.5 }, S, 80_000)).toThrow(/배율/);
  });
  it('rejects amount outside (0, maxAmountUsdt]', () => {
    expect(() => validateOpenOrder({ ...base, amountUsdt: 501 }, S, 80_000)).toThrow('한 번에 500 USDT까지만 가능해요');
    expect(() => validateOpenOrder({ ...base, amountUsdt: 0 }, S, 80_000)).toThrow('금액을 넣어 주세요');
  });
  it('rejects bad symbol/direction and missing price', () => {
    expect(() => validateOpenOrder({ ...base, symbol: 'DOGEUSDT' }, S, 80_000)).toThrow(/종목/);
    expect(() => validateOpenOrder({ ...base, direction: 'up' }, S, 80_000)).toThrow(/방향/);
    expect(() => validateOpenOrder(base, S, 0)).toThrow(/가격을 아직/);
  });
});

describe('validateTpSl', () => {
  it('null deletes, undefined leaves untouched', () => {
    expect(validateTpSl({ symbol: 'ETHUSDT', takeProfitPrice: null }, 'long', 2500)).toEqual({ symbol: 'ETHUSDT', takeProfitPrice: null });
    expect(validateTpSl({ symbol: 'ETHUSDT', stopLossPrice: 2400 }, 'long', 2500)).toEqual({ symbol: 'ETHUSDT', stopLossPrice: 2400 });
  });
  it('checks sides', () => {
    expect(() => validateTpSl({ symbol: 'ETHUSDT', stopLossPrice: 2600 }, 'long', 2500)).toThrow('손절가는 지금 가격보다 낮아야 해요');
    expect(() => validateTpSl({ symbol: 'ETHUSDT', takeProfitPrice: 2600 }, 'short', 2500)).toThrow('익절가는 지금 가격보다 낮아야 해요');
    expect(() => validateTpSl({ symbol: 'ETHUSDT' }, 'short', 2500)).toThrow('바꿀 값이 없어요');
  });
});

describe('validateSettings', () => {
  it('live requires api key', () => {
    expect(() => validateSettings({ mode: 'live' }, S, false)).toThrow(/API 키를 등록/);
    expect(validateSettings({ mode: 'live' }, S, true).mode).toBe('live');
  });
  it('paper 전환은 paperAllowed 일 때만 (연습 모드 제품 제거)', () => {
    const L: Settings = { ...S, mode: 'live' };
    expect(() => validateSettings({ mode: 'paper' }, L, true, true, false)).toThrow(/연습 모드는 더 이상 제공하지 않아요/);
    expect(validateSettings({ mode: 'paper' }, L, true, true, true).mode).toBe('paper');
    expect(validateSettings({ maxLeverage: 20 }, L, false, true, false).mode).toBe('live'); // 모드를 안 건드리면 통과
  });
  it('partial update keeps other fields', () => {
    expect(validateSettings({ maxLeverage: 20 }, S, false)).toEqual({ ...S, maxLeverage: 20 });
    expect(() => validateSettings({ maxLeverage: 0 }, S, false)).toThrow(/최대 배율/);
    expect(() => validateSettings({ usdtKrw: -1 }, S, false)).toThrow(/환율/);
  });
});

describe('signup fields', () => {
  it('loginId 3~20 alnum, password >= 6', () => {
    expect(validateLoginId('abc123')).toBe('abc123');
    expect(() => validateLoginId('ab')).toThrow(/아이디/);
    expect(() => validateLoginId('한글아이디')).toThrow(/아이디/);
    expect(validatePassword('123456')).toBe('123456');
    expect(() => validatePassword('12345')).toThrow(/비밀번호/);
  });
});
