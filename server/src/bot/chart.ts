// 텔레그램용 캔들 차트 PNG — 외부 라이브러리·폰트 없이 픽셀을 직접 찍는다 (Workers 에서 동작, 결정적).
// hlbot 차트(mplfinance)와 같은 구성: 캔들 + EMA28/120/210 + 카운트 번호 마커 + 현재가 선. 국내식 색(상승 빨강, 하락 파랑).
import { ema, type Candle } from './strategy.js';
import { kst } from './telegram.js';

export interface ChartMarker { tsMs: number; label: string }
export interface ChartOptions { coin: string; tf: string; candles: Candle[]; markers?: ChartMarker[]; displayBars?: number; width?: number; height?: number }

const UP = [229, 72, 77] as const, DOWN = [47, 111, 237] as const, INK = [30, 30, 30] as const, GRID = [228, 228, 228] as const, MUTED = [120, 120, 120] as const;
const EMA_COLORS: Record<number, readonly [number, number, number]> = { 28: [255, 149, 0], 120: [46, 160, 67], 210: [140, 82, 255] };

// 5×7 비트맵 글꼴 (숫자·영대문자·기호). '#'=칠함
const FONT: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'], '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'], M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'], O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'], ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'], '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'], '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '.#.##', '#..##'], ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '(': ['..#..', '.#...', '#....', '#....', '#....', '.#...', '..#..'], ')': ['..#..', '...#.', '....#', '....#', '....#', '...#.', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
};

class Raster {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number) { this.px = new Uint8Array(w * h * 3).fill(255); }
  set(x: number, y: number, c: readonly [number, number, number]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3; this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  rect(x: number, y: number, w: number, h: number, c: readonly [number, number, number]) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
  line(x0: number, y0: number, x1: number, y1: number, c: readonly [number, number, number], thick = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let t = 0; t < thick; t++) { this.set(x0, y0 + t, c); if (thick > 1) this.set(x0 + t, y0, c); }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  text(x: number, y: number, s: string, c: readonly [number, number, number], scale = 2) {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT['?'];
      for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === '#') this.rect(cx + k * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }
  triangleUp(cx: number, topY: number, size: number, c: readonly [number, number, number]) {
    for (let r = 0; r <= size; r++) this.rect(cx - r, topY + r, 2 * r + 1, 1, c);
  }
}
export const textWidth = (s: string, scale = 2) => s.length * 6 * scale;

function fmtAxis(v: number): string {
  if (v >= 10000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(1);
  return v.toPrecision(4);
}

/** 차트 픽셀 그리기 (PNG 인코딩 전 단계). 테스트에서 픽셀을 검사할 수 있게 분리 */
export function drawChart(o: ChartOptions): Raster {
  const W = o.width ?? 1000, H = o.height ?? 600;
  const R = new Raster(W, H);
  const all = o.candles;
  const n = Math.min(o.displayBars ?? 120, all.length);
  const view = all.slice(all.length - n);
  const emas: Record<number, number[]> = {};
  for (const span of [28, 120, 210]) emas[span] = ema(all.map((k) => k.c), span).slice(all.length - n);
  const left = 16, right = 96, top = 64, bottom = 44;
  const plotW = W - left - right, plotH = H - top - bottom;
  let lo = Infinity, hi = -Infinity;
  for (const k of view) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  for (const span of [28, 120, 210]) for (let i = 0; i < n; i++) { if (all.length - n + i >= span) { lo = Math.min(lo, emas[span][i]); hi = Math.max(hi, emas[span][i]); } }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const y = (p: number) => top + ((hi - p) / (hi - lo)) * plotH;
  const slot = plotW / n, bw = Math.max(2, Math.floor(slot * 0.62));
  const xc = (i: number) => Math.round(left + slot * i + slot / 2);

  // 격자 + 가격 축
  for (let t = 0; t <= 5; t++) {
    const p = lo + ((hi - lo) * t) / 5; const yy = Math.round(y(p));
    R.line(left, yy, left + plotW, yy, GRID);
    R.text(left + plotW + 8, yy - 7, fmtAxis(p), MUTED, 2);
  }
  // 시간 축 (약 6개)
  const step = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i += step) {
    const xx = xc(i); R.line(xx, top, xx, top + plotH, GRID);
    R.text(Math.max(left, xx - 30), H - bottom + 12, kst(view[i].t), MUTED, 2);
  }
  // EMA
  for (const span of [28, 120, 210]) {
    for (let i = 1; i < n; i++) { if (all.length - n + i - 1 < span) continue; R.line(xc(i - 1), y(emas[span][i - 1]), xc(i), y(emas[span][i]), EMA_COLORS[span], 2); }
  }
  // 캔들
  for (let i = 0; i < n; i++) {
    const k = view[i]; const c = k.c >= k.o ? UP : DOWN; const x = xc(i);
    R.line(x, y(k.h), x, y(k.l), c);
    const yo = Math.round(y(k.o)), yc = Math.round(y(k.c));
    R.rect(x - Math.floor(bw / 2), Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)), c);
  }
  // 현재가 선 + 라벨
  const last = view[n - 1]; const yl = Math.round(y(last.c));
  for (let xx = left; xx < left + plotW; xx += 8) R.line(xx, yl, xx + 3, yl, INK);
  R.rect(left + plotW + 2, yl - 9, right - 4, 18, INK); R.text(left + plotW + 8, yl - 7, fmtAxis(last.c), [255, 255, 255], 2);
  // 마커 (▲ + 번호)
  for (const m of o.markers ?? []) {
    const i = view.findIndex((k) => k.t === m.tsMs); if (i < 0) continue;
    const x = xc(i); const ty = Math.round(y(view[i].l)) + 6;
    R.triangleUp(x, ty, 7, INK);
    const label = m.label; R.rect(x - textWidth(label, 2) / 2 - 3, ty + 16, textWidth(label, 2) + 6, 18, INK); R.text(x - textWidth(label, 2) / 2, ty + 18, label, [255, 255, 255], 2);
  }
  // 제목 + 범례
  R.text(left, 14, `${o.coin} ${o.tf}  CLOSE ${fmtAxis(last.c)}  ${kst(last.t)} KST`, INK, 3);
  let lx = left;
  for (const span of [28, 120, 210]) { R.rect(lx, 44, 18, 4, EMA_COLORS[span]); R.text(lx + 24, 40, `EMA${span}`, MUTED, 2); lx += 24 + textWidth(`EMA${span}`, 2) + 20; }
  return R;
}

// ---- PNG 인코딩 (8bit RGB, 필터 0, zlib 은 CompressionStream) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter(); void w.write(raw); void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
export async function encodePng(r: Raster): Promise<Uint8Array> {
  const rowLen = r.w * 3 + 1; const raw = new Uint8Array(rowLen * r.h);
  for (let yy = 0; yy < r.h; yy++) { raw[yy * rowLen] = 0; raw.set(r.px.subarray(yy * r.w * 3, (yy + 1) * r.w * 3), yy * rowLen + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, r.w); dv.setUint32(4, r.h); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
export async function renderChartPng(o: ChartOptions): Promise<Uint8Array> { return encodePng(drawChart(o)); }
