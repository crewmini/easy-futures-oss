// Hyperliquid 공개 캔들 (무인증). hlbot 이 라벨링·보정된 것과 같은 데이터를 쓴다.
import { net } from './net.js';
import { intervalMs, type Candle } from './strategy.js';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

export async function fetchCandles(coin: string, tf: string, bars: number, endMs = Date.now(), infoUrl = HL_INFO_URL): Promise<Candle[]> {
  const step = intervalMs(tf);
  const res = await net.fetch(infoUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: endMs - bars * step, endTime: endMs } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`캔들 조회 실패 HTTP ${res.status}`);
  const rows = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`캔들 없음: ${coin} ${tf}`);
  // 응답 순서를 신뢰하지 않는다: 중복 제거(나중 값 유지) 후 시간순 정렬
  const byT = new Map<number, Candle>();
  for (const r of rows) byT.set(Number(r.t), { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(-bars);
}
