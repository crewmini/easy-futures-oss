import { describe, it, expect } from 'vitest';
import { entrySizing, lossLimitUsed, mergedEntry, reduceContracts } from './sizing.js';

const ETH = { contractSize: 0.01, maxLeverage: 100, minVolume: 1 };   // 1계약 = 0.01 ETH (≈25 USDT 명목 @2500)
const BTC = { contractSize: 0.001, maxLeverage: 100, minVolume: 1 };

describe('entrySizing (비례)', () => {
  it('마스터가 자산의 10%를 10배로 썼으면 팔로워도 따라갈 돈의 10%를 10배로', () => {
    // 마스터: 자산 10,000, 40계약 ETH @2500 10배 → 명목 1,000, 증거금 100 = 1%
    const r = entrySizing({ masterDelta: 40, price: 2500, masterLeverage: 10, masterEquity: 10_000, copyAmountNow: 1_000, available: 5_000, followerMaxLeverage: 20, contract: ETH });
    expect(r.ratio).toBeCloseTo(0.01, 6);
    expect(r.leverage).toBe(10);
    expect(r.marginUsdt).toBeCloseTo(10, 2);        // 1,000 × 1% = 10 USDT
    expect(r.contracts).toBe(4);                     // 10 × 10 / 25 = 4계약
    expect(r.cappedByAvailable).toBe(false); expect(r.reason).toBeNull();
  });
  it('배율은 팔로워 상한·거래소 상한으로 자른다 (계약 수도 그만큼 준다)', () => {
    const r = entrySizing({ masterDelta: 40, price: 2500, masterLeverage: 50, masterEquity: 10_000, copyAmountNow: 1_000, available: 5_000, followerMaxLeverage: 5, contract: ETH });
    expect(r.leverage).toBe(5);
    // 마스터 증거금 = 1000/50 = 20 → r = 0.2% → 팔로워 2 USDT, 5배 → 명목 10 → 0계약 (25 USDT/계약)
    expect(r.contracts).toBe(0); expect(r.reason).toContain('금액이 너무 적음');
  });
  it('쓸 수 있는 돈이 모자라면 그만큼만', () => {
    const r = entrySizing({ masterDelta: 400, price: 2500, masterLeverage: 10, masterEquity: 10_000, copyAmountNow: 1_000, available: 30, followerMaxLeverage: 10, contract: ETH });
    expect(r.ratio).toBeCloseTo(0.1, 6);            // 마스터 10% → 팔로워 100 USDT 필요
    expect(r.cappedByAvailable).toBe(true); expect(r.marginUsdt).toBeLessThanOrEqual(30);
    expect(r.contracts).toBe(11);                    // 수수료 자리: 30 / (1 + 0.0005×10) = 29.85 → ×10 / 25 = 11 (딱 12 는 거래소가 잔고 부족으로 거절)
    // 불타기: 기존 포지션 배율 고정
    expect(entrySizing({ masterDelta: 40, price: 2500, masterLeverage: 10, masterEquity: 10_000, copyAmountNow: 1_000, available: 5_000, followerMaxLeverage: 20, fixedLeverage: 5, contract: ETH }).leverage).toBe(5);
  });
  it('마스터 비율은 1을 넘지 않고, 자산 정보가 없으면 진입 안 함', () => {
    expect(entrySizing({ masterDelta: 1_000_000, price: 2500, masterLeverage: 1, masterEquity: 10, copyAmountNow: 100, available: 100, followerMaxLeverage: 10, contract: ETH }).ratio).toBe(1);
    expect(entrySizing({ masterDelta: 1, price: 2500, masterLeverage: 10, masterEquity: 0, copyAmountNow: 100, available: 100, followerMaxLeverage: 10, contract: ETH }).contracts).toBe(0);
    expect(entrySizing({ masterDelta: 0, price: 2500, masterLeverage: 10, masterEquity: 100, copyAmountNow: 100, available: 100, followerMaxLeverage: 10, contract: ETH }).contracts).toBe(0);
  });
  it('BTC 소수 계약 단위도 정수 계약으로 내림', () => {
    // 마스터 자산 50,000, 100계약(0.1 BTC) @80,000 20배 → 증거금 400 = 0.8% → 팔로워 2,000 의 0.8% = 16 USDT, 20배 → 320 명목 / 80 = 4계약
    const r = entrySizing({ masterDelta: 100, price: 80_000, masterLeverage: 20, masterEquity: 50_000, copyAmountNow: 2_000, available: 2_000, followerMaxLeverage: 50, contract: BTC });
    expect(r.contracts).toBe(4); expect(r.leverage).toBe(20);
  });
});

describe('reduceContracts', () => {
  it('마스터가 절반 줄이면 장부의 절반, 0 이면 전량, 늘리면 0', () => {
    expect(reduceContracts(40, 20, 4)).toEqual({ contracts: 2, carry: 0 });
    expect(reduceContracts(40, 0, 4)).toEqual({ contracts: 4, carry: 0 });
    expect(reduceContracts(40, 50, 4)).toEqual({ contracts: 0, carry: 0 });
    expect(reduceContracts(40, 39, 4)).toEqual({ contracts: 0, carry: 0.1 });   // 1계약 미만 → 정리하지 않고 이월 (예전 "최소 1계약" 규칙 폐기, 2026-09-22)
    expect(reduceContracts(40, 20, 0)).toEqual({ contracts: 0, carry: 0 });
    expect(reduceContracts(0, 0, 3)).toEqual({ contracts: 3, carry: 0 });
  });
  it('이월(carry)은 정확한 비례 수량에 더해지고, 늘리는 이벤트에서는 그대로 남는다', () => {
    expect(reduceContracts(100, 50, 5, 0.7)).toEqual({ contracts: 3, carry: 0.2 });   // 2.5 + 0.7 = 3.2
    expect(reduceContracts(40, 50, 4, 0.3)).toEqual({ contracts: 0, carry: 0.3 });
    expect(reduceContracts(100, 50, 1, 0.5)).toEqual({ contracts: 1, carry: 0 });     // 0.5 + 0.5 = 1.0 → 전량, 이월 0
    expect(reduceContracts(100, 10, 1, 0.99)).toEqual({ contracts: 1, carry: 0.89 });  // 0.9 + 0.99 = 1.89 → 장부(1)로 자르고 나머지는 산술 그대로 (행이 지워져 쓰이진 않는다)
  });
});

describe('lossLimitUsed / mergedEntry', () => {
  it('손실 한도 사용률', () => {
    expect(lossLimitUsed(1000, 50, -100, -150)).toBeCloseTo(0.5, 6);
    expect(lossLimitUsed(1000, 50, 50, 20)).toBe(0);
    expect(lossLimitUsed(1000, 50, -600, 0)).toBeCloseTo(1.2, 6);
    expect(lossLimitUsed(0, 50, -600, 0)).toBe(0);
  });
  it('평단 합산', () => {
    expect(mergedEntry(4, 2500, 4, 2600)).toBeCloseTo(2550, 6);
    expect(mergedEntry(0, 0, 4, 2600)).toBe(2600);
  });
});
