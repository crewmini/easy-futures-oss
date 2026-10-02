import { describe, it, expect } from 'vitest';
import { DEFAULT_GATE_LIMITS, GATE_WINDOW_MS, gateBucket, RateGate } from './RateGate.js';

describe('RateGate (거래소 요청 관문)', () => {
  it('버킷 이름은 경로 마지막 조각', () => {
    expect(gateBucket('/contract/private/position-v2?symbol=BTCUSDT')).toBe('position-v2');
    expect(gateBucket('/contract/private/submit-order')).toBe('submit-order');
  });
  it('창 안 허용 횟수까지는 즉시, 넘치면 가장 오래된 슬롯이 빠지는 시각까지 기다리게 한다', () => {
    const g = Object.create(RateGate.prototype) as RateGate;
    (g as unknown as { slots: Map<string, number[]>; limits: null; env: Record<string, unknown> }).slots = new Map();
    (g as unknown as { limits: null }).limits = null;
    (g as unknown as { env: Record<string, unknown> }).env = {};
    const limit = DEFAULT_GATE_LIMITS['position-v2'];
    const t0 = 1_000_000;
    for (let i = 0; i < limit; i++) expect(g.take('position-v2', t0 + i * 10)).toBe(0);
    const w = g.take('position-v2', t0 + limit * 10);
    expect(w).toBeGreaterThan(0); expect(w).toBeLessThanOrEqual(GATE_WINDOW_MS);
    // 창이 지나면 다시 즉시
    expect(g.take('position-v2', t0 + GATE_WINDOW_MS + 5_000)).toBe(0);
    // 다른 버킷은 독립
    expect(g.take('assets-detail', t0 + limit * 10)).toBe(0);
  });
});
