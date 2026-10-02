import { describe, it, expect } from 'vitest';
import { drawChart, encodePng, renderChartPng } from './chart.js';
import type { Candle } from './strategy.js';

const STEP = 15 * 60_000;
function mk(n: number): Candle[] { return Array.from({ length: n }, (_, i) => { const base = 2400 + Math.sin(i / 9) * 40 + i * 0.1; const up = i % 3 !== 0; return { t: 1_700_000_000_000 + i * STEP, o: base, h: base + 12, l: base - 12, c: up ? base + 6 : base - 6, v: 1 }; }); }

describe('chart', () => {
  it('draws candles in korean colors, markers and title', () => {
    const k = mk(400);
    const r = drawChart({ coin: 'ETH', tf: '15m', candles: k, markers: [{ tsMs: k[380].t, label: '1' }, { tsMs: k[395].t, label: '2' }] });
    expect(r.w).toBe(1000); expect(r.h).toBe(600);
    const px = (x: number, y: number) => [r.px[(y * r.w + x) * 3], r.px[(y * r.w + x) * 3 + 1], r.px[(y * r.w + x) * 3 + 2]];
    let red = 0, blue = 0, orange = 0, dark = 0;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const [a, b, c] = px(x, y); if (a === 229 && b === 72) red++; else if (a === 47 && b === 111) blue++; else if (a === 255 && b === 149) orange++; else if (a === 30 && b === 30) dark++; }
    expect(red).toBeGreaterThan(500); expect(blue).toBeGreaterThan(200); expect(orange).toBeGreaterThan(100); expect(dark).toBeGreaterThan(200);
  });
  it('encodes a valid PNG with correct dimensions', async () => {
    const png = await renderChartPng({ coin: 'BTC', tf: '1h', candles: mk(240), width: 400, height: 240 });
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect(dv.getUint32(16)).toBe(400); expect(dv.getUint32(20)).toBe(240);
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
    expect(png.length).toBeLessThan(60_000);
  });
  it('handles short history (fewer bars than EMA spans)', async () => {
    const png = await encodePng(drawChart({ coin: 'SOL', tf: '15m', candles: mk(40) }));
    expect(png.length).toBeGreaterThan(100);
  });
});
