import { describe, it, expect } from 'vitest';
import { calcContracts, type ContractInfo } from '@easy-futures/shared';
import { checkTriggers, closePosition, newAccount, openPosition, reducePosition, setLeverage, toPositions, toWallet, updateTpSl, TAKER_FEE } from './engine.js';

const BTC: ContractInfo = { symbol: 'BTCUSDT', contractSize: 0.001, pricePrecision: 0.1, volPrecision: 1, minVolume: 1, maxLeverage: 200 };
const P = (last: number) => ({ BTCUSDT: { last, mark: last, updatedAt: 1 } });

describe('paper engine', () => {
  it('open long → pnl moves with price → SL triggers → balance updated', () => {
    const acc = newAccount(1000, 0);
    const price = 80_000;
    const contracts = calcContracts(100, 5, price, BTC); // 100*5/(80000*0.001) = 6.25 → 6
    expect(contracts).toBe(6);
    const res = openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_600 }, contracts, BTC, price, 1);
    expect(res.contracts).toBe(6);
    expect(res.coinAmount).toBeCloseTo(0.006, 8);
    expect(res.entryPrice).toBe(price);

    const notional = 0.006 * price; // 480
    const margin = notional / 5; // 96
    const fee = notional * TAKER_FEE; // 0.24
    expect(acc.balance).toBeCloseTo(1000 - margin - fee, 6);
    expect(acc.positions).toHaveLength(1);
    expect(acc.positions[0].liquidationPrice).toBeLessThan(77_600);

    // 가격 +1% → 손익 = 0.006 * 800 = 4.8, 증거금 대비 5%
    const up = toPositions(acc, P(80_800))[0];
    expect(up.unrealizedPnl).toBeCloseTo(4.8, 4);
    expect(up.unrealizedPct).toBeCloseTo(5, 1);
    const w = toWallet(acc, P(80_800));
    expect(w.positionMargin).toBeCloseTo(96, 4);
    expect(w.equity).toBeCloseTo(1000 - fee + 4.8, 4);

    // 손절가 위에서는 아무 일도 없다
    expect(checkTriggers(acc, { BTCUSDT: 77_700 }, 2)).toHaveLength(0);
    // 손절가 도달 → 정리
    const evs = checkTriggers(acc, { BTCUSDT: 77_500 }, 3);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('sl');
    expect(acc.positions).toHaveLength(0);
    const pnl = (77_500 - 80_000) * 0.006; // -15
    const closeFee = 0.006 * 77_500 * TAKER_FEE;
    expect(acc.balance).toBeCloseTo(1000 - fee + pnl - closeFee, 4);
    expect(acc.history.at(-1)?.pnl).toBeCloseTo(pnl, 4);
  });

  it('rejects contracts = 0 (금액이 너무 적어요)', () => {
    const acc = newAccount(1000);
    const contracts = calcContracts(1, 1, 80_000, BTC); // 0.0125 → 0
    expect(contracts).toBe(0);
    expect(() => openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 1, leverage: 1, stopLossPrice: 70_000 }, contracts, BTC, 80_000)).toThrow(
      '금액이 너무 적어요',
    );
    expect(acc.balance).toBe(1000);
  });

  it('rejects opposite direction on the same symbol (먼저 정리해 주세요)', () => {
    const acc = newAccount(1000);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 70_000 }, 6, BTC, 80_000);
    expect(() => openPosition(acc, { symbol: 'BTCUSDT', direction: 'short', amountUsdt: 100, leverage: 5, stopLossPrice: 90_000 }, 6, BTC, 80_000)).toThrow(
      /먼저 정리해 주세요/,
    );
  });

  it('same direction averages the entry price', () => {
    const acc = newAccount(1000);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 70_000 }, 6, BTC, 80_000);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 75_000 }, 6, BTC, 82_000);
    expect(acc.positions).toHaveLength(1);
    expect(acc.positions[0].contracts).toBe(12);
    expect(acc.positions[0].entryPrice).toBeCloseTo(81_000, 6);
    expect(acc.positions[0].stopLossPrice).toBe(75_000);
    expect(acc.positions[0].leverage).toBeCloseTo(5, 1);
  });

  it('rejects when paper balance is insufficient', () => {
    const acc = newAccount(10);
    expect(() => openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 70_000 }, 6, BTC, 80_000)).toThrow(/잔고가 부족/);
  });

  it('liquidation loses the whole margin, never more', () => {
    const acc = newAccount(1000, 0);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 10, stopLossPrice: 60_000 }, 12, BTC, 80_000, 1);
    const pos = acc.positions[0];
    const balanceAfterOpen = acc.balance;
    // 강제정리가(≈ entry*(1-1/10+0.005) = 72,400) 보다 훨씬 아래로 급락
    const evs = checkTriggers(acc, { BTCUSDT: 60_000 }, 2);
    expect(evs[0].type).toBe('liq');
    expect(acc.positions).toHaveLength(0);
    expect(acc.balance).toBeCloseTo(balanceAfterOpen, 6); // 증거금만 사라진다
    expect(evs[0].pnl).toBeCloseTo(-pos.marginUsdt, 6);
  });

  it('take profit triggers for short when price falls', () => {
    const acc = newAccount(1000);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'short', amountUsdt: 100, leverage: 5, stopLossPrice: 84_000, takeProfitPrice: 78_000 }, 6, BTC, 80_000);
    expect(checkTriggers(acc, { BTCUSDT: 79_000 })).toHaveLength(0);
    const evs = checkTriggers(acc, { BTCUSDT: 77_900 });
    expect(evs[0].type).toBe('tp');
    expect(evs[0].pnl).toBeCloseTo((80_000 - 77_900) * 0.006, 4);
  });

  it('updateTpSl and manual close', () => {
    const acc = newAccount(1000);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 70_000 }, 6, BTC, 80_000);
    updateTpSl(acc, { symbol: 'BTCUSDT', stopLossPrice: 75_000, takeProfitPrice: 90_000 });
    expect(acc.positions[0].stopLossPrice).toBe(75_000);
    expect(acc.positions[0].takeProfitPrice).toBe(90_000);
    updateTpSl(acc, { symbol: 'BTCUSDT', takeProfitPrice: null });
    expect(acc.positions[0].takeProfitPrice).toBeNull();
    expect(acc.positions[0].stopLossPrice).toBe(75_000);
    closePosition(acc, 'BTCUSDT', 80_000, 'close');
    expect(acc.positions).toHaveLength(0);
    expect(() => closePosition(acc, 'BTCUSDT', 80_000)).toThrow(/포지션이 없어요/);
    expect(() => updateTpSl(acc, { symbol: 'ETHUSDT', stopLossPrice: 1 })).toThrow(/포지션이 없어요/);
  });

  it('keeps at most 100 history events', () => {
    const acc = newAccount(1_000_000);
    for (let i = 0; i < 120; i++) {
      openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 10, leverage: 1, stopLossPrice: 1 }, 1, BTC, 100);
      closePosition(acc, 'BTCUSDT', 100);
    }
    expect(acc.history.length).toBe(100);
  });

  it('partial close realizes proportional pnl/fee/margin and keeps the rest unchanged', () => {
    const acc = newAccount(1000, 0);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_000, takeProfitPrice: 90_000 }, 10, BTC, 80_000, 1);
    const pos = acc.positions[0];
    const marginBefore = pos.marginUsdt; // 0.01 * 80000 / 5 = 160
    const balanceBefore = acc.balance;
    const ev = reducePosition(acc, 'BTCUSDT', 4, 82_000, 2);
    expect(ev.type).toBe('close');
    expect(ev.contracts).toBe(4);
    const pnl = (82_000 - 80_000) * 0.004; // 8
    const fee = 0.004 * 82_000 * TAKER_FEE;
    expect(ev.pnl).toBeCloseTo(pnl, 6);
    expect(acc.positions).toHaveLength(1);
    expect(pos.contracts).toBe(6);
    expect(pos.marginUsdt).toBeCloseTo(marginBefore * 0.6, 6);
    expect(pos.entryPrice).toBe(80_000);
    expect(pos.leverage).toBe(5);
    expect(pos.stopLossPrice).toBe(77_000);
    expect(pos.takeProfitPrice).toBe(90_000);
    expect(acc.balance).toBeCloseTo(balanceBefore + marginBefore * 0.4 + pnl - fee, 6);
    // 남은 수량 이상을 요청하면 전량 정리
    const ev2 = reducePosition(acc, 'BTCUSDT', 99, 82_000, 3);
    expect(ev2.contracts).toBe(6);
    expect(acc.positions).toHaveLength(0);
    expect(acc.balance).toBeCloseTo(1000 - 0.01 * 80_000 * TAKER_FEE + (82_000 - 80_000) * 0.01 - 0.01 * 82_000 * TAKER_FEE, 4);
    expect(() => reducePosition(acc, 'BTCUSDT', 1, 82_000)).toThrow(/포지션이 없어요/);
  });

  it('partial close rejects zero contracts and caps loss at the closed share of margin', () => {
    const acc = newAccount(1000, 0);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 10, stopLossPrice: 60_000 }, 10, BTC, 80_000, 1);
    expect(() => reducePosition(acc, 'BTCUSDT', 0, 80_000)).toThrow(/계약 수/);
    const pos = acc.positions[0];
    const before = acc.balance;
    // 절반을 증거금 이상 손실 가격에서 정리 → 그 절반 증거금만 잃는다
    const ev = reducePosition(acc, 'BTCUSDT', 5, 60_000, 2);
    expect(ev.pnl).toBeCloseTo(-40, 6); // 절반 증거금 = 80/2
    expect(ev.fee).toBe(0);
    expect(acc.balance).toBeCloseTo(before, 6);
    expect(pos.contracts).toBe(5);
    expect(pos.marginUsdt).toBeCloseTo(40, 6);
  });

  it('setLeverage re-margins the open position and moves the liquidation price', () => {
    const acc = newAccount(1000, 0);
    openPosition(acc, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 77_000 }, 10, BTC, 80_000, 1);
    const pos = acc.positions[0];
    const balance = acc.balance;
    expect(pos.marginUsdt).toBeCloseTo(160, 6);
    const liq5 = pos.liquidationPrice;
    setLeverage(acc, 'BTCUSDT', 20);
    expect(pos.leverage).toBe(20);
    expect(pos.marginUsdt).toBeCloseTo(40, 6);
    expect(acc.balance).toBeCloseTo(balance + 120, 6);
    expect(pos.liquidationPrice).toBeGreaterThan(liq5); // 배율을 올리면 강제정리가 가까워진다 (76,400 > 64,400)
    setLeverage(acc, 'BTCUSDT', 2);
    expect(pos.marginUsdt).toBeCloseTo(400, 6);
    expect(acc.balance).toBeCloseTo(balance + 120 - 360, 6);
    expect(() => setLeverage(acc, 'ETHUSDT', 3)).toThrow(/포지션이 없어요/);
    expect(() => setLeverage(acc, 'BTCUSDT', 0)).toThrow(/배율/);
    const poor = newAccount(1, 0);
    poor.balance = 200; openPosition(poor, { symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 10, stopLossPrice: 70_000 }, 10, BTC, 80_000, 1);
    expect(() => setLeverage(poor, 'BTCUSDT', 1)).toThrow(/잔고가 부족/);
  });
});
