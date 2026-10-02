export const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
export const nf2 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

/** 가격 표시: 1000 이상은 정수, 그 미만은 소수 2자리. 예) 96,010 / 3,120.5 */
export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return '—';
  if (Math.abs(p) >= 1000) return nf0.format(Math.round(p));
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(p);
}
export function fmtUsdt(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return '—';
  return new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
}
export function fmtKrw(usdt: number | null | undefined, rate: number): string {
  if (usdt == null || !isFinite(usdt)) return '—';
  const krw = usdt * rate;
  if (Math.abs(krw) >= 10000) return `${nf0.format(Math.round(krw / 1000) * 1000)}원`;
  return `${nf0.format(Math.round(krw))}원`;
}
export function fmtSigned(v: number, digits = 2): string {
  const s = fmtUsdt(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}%` : `${s}%`;
}
export function fmtCoin(v: number, coin: string): string {
  const d = coin === 'BTC' ? 4 : 3;
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: d }).format(v)} ${coin}`;
}
export function vibrate(ms: number | number[]) { try { navigator.vibrate?.(ms); } catch { /* ignore */ } }
