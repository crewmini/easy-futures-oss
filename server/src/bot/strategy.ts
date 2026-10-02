// 저점 카운팅("3의 법칙") 순수 로직 — hlbot(파이썬) signals/{pivots,counting,bottom}.py 를 1:1 이식.
// DB·네트워크 없음. 캔들은 시각 오름차순 배열.
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export const INTERVAL_MS: Record<string, number> = {
  '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000, '1h': 3_600_000, '2h': 2 * 3_600_000,
  '4h': 4 * 3_600_000, '8h': 8 * 3_600_000, '12h': 12 * 3_600_000, '1d': 86_400_000, '3d': 3 * 86_400_000,
  '1w': 7 * 86_400_000, '1M': 30 * 86_400_000,
};
export const SUPPORTED_TFS = Object.keys(INTERVAL_MS);
export function intervalMs(tf: string): number {
  const v = INTERVAL_MS[tf];
  if (!v) throw new Error(`지원하지 않는 타임프레임: ${tf}`);
  return v;
}

/** 지수이동평균 — pandas ewm(span, adjust=False) 와 동일한 재귀식 (TradingView EMA) */
export function ema(values: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) out[i] = i === 0 ? values[0] : a * values[i] + (1 - a) * out[i - 1];
  return out;
}

/** 좌우 확인봉 대비 최저가인 봉의 인덱스. 왼쪽 strict(<), 오른쪽 non-strict(<=) — 같은 저가 연속 시 첫 봉만 */
export function findPivotLows(candles: Candle[], left = 3, right = 3): number[] {
  const out: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const v = candles[i].l;
    let leftMin = Infinity, rightMin = Infinity;
    for (let j = i - left; j < i; j++) leftMin = Math.min(leftMin, candles[j].l);
    for (let j = i + 1; j <= i + right; j++) rightMin = Math.min(rightMin, candles[j].l);
    if (v < leftMin && v <= rightMin) out.push(i);
  }
  return out;
}

// ---- 1번(바닥 리테스트) 규칙 — 2026-07-19 사용자 확정 정의 ----
export const BOTTOM_WINDOW = 120;          // 바닥 탐색 창(직전 봉수)
export const BOTTOM_BAND_BASE_PCT = 3.0;   // 15m 기준 ±밴드, TF 길이의 √에 비례
export const BOTTOM_BAND_MAX_PCT = 10.0;
export const MIN_BARS_AFTER_BOTTOM = 16;   // 이 이상 지났으면 무조건 리테스트 자격
export const MIN_BARS_EARLY = 4;           // 실질 반등이 있으면 4봉부터 인정
export const BOUNCE_MIN_BAND_RATIO = 0.4;
export const UNDERCUT_TOL_PCT = 0.5;       // 바닥 -0.5% 넘게 깨면 리테스트 아님

export function bottomBandPct(tf: string): number {
  const scale = Math.sqrt(intervalMs(tf) / intervalMs('15m'));
  return Math.min(BOTTOM_BAND_MAX_PCT, BOTTOM_BAND_BASE_PCT * scale);
}

/** 위치 i 의 저가가 '바닥 이후 바닥권 리테스트' 조건을 만족하는가 (hlbot is_retest_low) */
export function isRetestLow(candles: Candle[], i: number, tf: string): boolean {
  if (i < BOTTOM_WINDOW) return false;
  const low = candles[i].l;
  let priorMin = Infinity, mPos = -1;
  for (let j = i - BOTTOM_WINDOW; j < i; j++) if (candles[j].l < priorMin) { priorMin = candles[j].l; mPos = j - (i - BOTTOM_WINDOW); }
  if (priorMin <= 0) return false;
  const band = bottomBandPct(tf);
  const distPct = (low / priorMin - 1) * 100;
  if (distPct > band || distPct < -UNDERCUT_TOL_PCT) return false;
  if (mPos === 0) return false; // 바닥이 창 경계 — 진짜 바닥이 더 과거일 수 있어 기준 신뢰 불가
  const bottomJ = i - BOTTOM_WINDOW + mPos;
  const barsSince = i - bottomJ;
  if (barsSince >= MIN_BARS_AFTER_BOTTOM) return true;
  if (barsSince < MIN_BARS_EARLY) return false;
  // 바닥 봉 자신의 윗꼬리는 반등이 아님 — 다음 봉부터 측정
  let hmax = -Infinity;
  for (let j = bottomJ + 1; j < i; j++) hmax = Math.max(hmax, candles[j].h);
  if (hmax === -Infinity) return false;
  return (hmax / priorMin - 1) * 100 >= band * BOUNCE_MIN_BAND_RATIO;
}

// ---- 카운트 상태머신 ----
export const MIN_GAP_BARS = 10; // 직전 카운트와의 최소 봉 간격
export interface ChainEntry { id?: number; seq: number; tsMs: number; low: number; status: 'proposed' | 'confirmed' }
export interface Decision { action: 'propose' | 'propose_reanchor' | 'none'; seq: number | null }

export function decide(chain: ChainEntry[], cand: { tsMs: number; low: number }, barGap: number): Decision {
  if (chain.length === 0) return { action: 'propose', seq: 1 };
  const anchor = chain[0];
  if (cand.low < anchor.low) return { action: 'propose_reanchor', seq: 1 }; // 앵커 붕괴 — 간격 조건 무관
  const last = chain[chain.length - 1];
  if (last.seq >= 3) return { action: 'none', seq: null };
  if (barGap < MIN_GAP_BARS) return { action: 'none', seq: null };
  if (cand.low < last.low) return { action: 'none', seq: null }; // 앵커보단 높지만 직전보다 낮음 — 시퀀스 훼손
  return { action: 'propose', seq: last.seq + 1 };
}

/** 마감 봉만 (open + step <= now) */
export function closedOnly(candles: Candle[], tf: string, nowMs: number): Candle[] {
  const step = intervalMs(tf);
  return candles.filter((k) => k.t + step <= nowMs);
}
