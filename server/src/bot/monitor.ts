// 라이브 감시 루프 — hlbot monitor.py 이식. 마감 봉에서 저점 후보를 평가해 카운트 제안(텔레그램 버튼)을 보낸다.
// 의존(캔들 조회·메시지 발송·현재 시각)은 주입 — 테스트에서 가짜로 바꾼다.
import * as store from './db.js';
import { closedOnly, decide, ema, findPivotLows, intervalMs, isRetestLow, type Candle } from './strategy.js';
import { renderChartPng, type ChartMarker } from './chart.js';
import { fmtPx, kst, type InlineKeyboard } from './telegram.js';

export const EVAL_BARS = 240;      // EMA28 워밍업 포함
export const PIVOT_W = 5;
export const EMA_TOUCH_TOL = 1.002;
export const VOL_SPIKE_MULT = 2.5;
export const CHART_BARS = 600;      // EMA210 워밍업 포함 조회 봉수
export const DISPLAY_BARS = 120;

export interface MonitorDeps {
  fetchCandles: (coin: string, tf: string, bars: number) => Promise<Candle[]>;
  /** 관리자에게 발송. 메시지 id 반환. 실패 시 throw */
  send: (text: string, keyboard?: InlineKeyboard | null) => Promise<number>;
  /** 차트 사진 + 캡션. 없거나 실패하면 send 로 대체 */
  sendPhoto?: (png: Uint8Array, caption: string, keyboard?: InlineKeyboard | null) => Promise<number>;
  now: () => number;
}

/** 감시목록 전체를 한 번 평가. 조합별 예외는 기록만 하고 계속 */
export async function pollOnce(db: D1Database, deps: MonitorDeps): Promise<void> {
  const watches = await store.listWatches(db);
  for (const [coin, tfs] of Object.entries(watches)) {
    for (const tf of tfs) {
      try { await evalWatch(db, coin, tf, deps); await store.markPolled(db, coin, tf, null); }
      catch (e) { await store.markPolled(db, coin, tf, (e as Error).message).catch(() => {}); }
    }
  }
}

export async function evalWatch(db: D1Database, coin: string, tf: string, deps: MonitorDeps): Promise<void> {
  const all = await deps.fetchCandles(coin, tf, EVAL_BARS);
  const closed = closedOnly(all, tf, deps.now());
  if (closed.length < PIVOT_W * 2 + 21) return;

  const settings = await store.getBotSettings(db);
  // 이탈 감지: 활성 카운트 저가 아래로 '마감'하면 피봇 확정을 기다리지 않고 즉시 알림 (꼬리 터치는 무시)
  let chain = await store.activeChain(db, coin, tf);
  if (chain.length) await checkBreak(db, coin, tf, closed, chain, deps, settings);

  const targetI = closed.length - 1 - PIVOT_W; // 이제 막 피봇 확정 가능한 봉
  const targetMs = closed[targetI].t;
  const watermark = await store.getWatermark(db, coin, tf);
  if (targetMs <= watermark) return;

  // 다운타임 동안 확정된 피봇이 소실되지 않게 (watermark, target] 구간 전부 순서대로. 초기 기동(0)은 타깃 봉만
  const pivots = findPivotLows(closed.slice(0, targetI + PIVOT_W + 1), PIVOT_W, PIVOT_W);
  const candidates = watermark > 0 ? pivots.filter((i) => closed[i].t > watermark && closed[i].t <= targetMs) : pivots.filter((i) => closed[i].t === targetMs);

  const ema28 = ema(closed.map((k) => k.c), 28);
  for (const ci of candidates) {
    const cand = closed[ci];
    chain = await store.activeChain(db, coin, tf); // 매 후보마다 최신 체인
    let barGap = 999;
    if (chain.length) {
      const lastI = closed.findIndex((k) => k.t === chain[chain.length - 1].tsMs);
      if (lastI >= 0) barGap = ci - lastI;
    }
    const decision = decide(chain, { tsMs: cand.t, low: cand.l }, barGap);
    if (decision.action === 'none') {
      // 3 완성 체인은 영구 침묵 — 새 사이클 후보(유효 리테스트)가 오면 리셋 여부를 묻는다
      if (chain.length && chain[chain.length - 1].seq >= 3 && cand.l >= chain[0].low && isRetestLow(closed, ci, tf)) {
        await sendWithChart(deps, coin, tf, closed, [...chain.map((e) => ({ tsMs: e.tsMs, label: String(e.seq) })), { tsMs: cand.t, label: 'NEW' }],
          `🔁 ${coin} · ${tf} — 3 완성 체인이 유지 중인데 새 사이클로 보이는 리테스트 저점(${fmtPx(cand.l)} · ${kst(cand.t)} KST)이 나왔어요.\n기존 체인을 리셋하고 새 1번 탐색을 시작할까요?`,
          [[{ text: '🔁 리셋하고 새 사이클', callback_data: `cnt:reset:${coin}:${tf}:nc` }, { text: '무시', callback_data: 'cnt:ignore:-' }]],
        );
      }
      await store.setWatermark(db, coin, tf, cand.t);
      continue;
    }
    if (decision.action === 'propose' && decision.seq === 1) {
      // 1번 = 바닥이 아니라 "바닥 이후 바닥권을 지켜낸 첫 리테스트". EMA28 터치 게이트는 1번에만
      if (cand.l > ema28[ci] * EMA_TOUCH_TOL || !isRetestLow(closed, ci, tf)) { await store.setWatermark(db, coin, tf, cand.t); continue; }
    }
    // 발송 실패 시 예외가 전파돼 워터마크를 전진시키지 않는다 (다음 폴에서 같은 봉 재시도)
    await sendProposal(db, coin, tf, closed, ci, decision, chain, deps, settings);
    await store.setWatermark(db, coin, tf, cand.t);
  }
  if ((await store.getWatermark(db, coin, tf)) < targetMs) await store.setWatermark(db, coin, tf, targetMs); // 후보 없어도 전진
}

/** 활성 카운트 저가 아래로 마감한 봉 감지 — '연속 하회 구간'당 1회 알림. 취소 여부는 사용자 버튼.
 *  자동 대상 체인(1번이 ✅ 로 신호가 나간 체인)이면 유예 뒤 자동 취소+전량 정리 대기로 등록하고, '무시' 를 누르면 유지 */
async function checkBreak(db: D1Database, coin: string, tf: string, closed: Candle[], chain: store.CountRow[], deps: MonitorDeps, settings: store.BotSettings): Promise<void> {
  const close = closed[closed.length - 1].c;
  const broken = chain.find((e) => close < e.low);
  if (!broken) return;
  let j = closed.length - 1;
  while (j > 0 && closed[j - 1].c < broken.low) j--;
  const lastBreak = await store.getBreakMs(db, coin, tf);
  if (j === 0 && lastBreak > 0) return; // 스트릭이 조회 프레임보다 길면 시작점 불명 — 이미 알렸으면 침묵
  const streakStart = closed[j].t;
  if (streakStart <= lastBreak) return; // 이 구간은 이미 알림함
  const when = kst(closed[closed.length - 1].t);
  const auto = store.autoEligible(settings, tf, chain);
  const effect = broken.status === 'confirmed' ? '(취소하면 AI 자동매매 사용자 포지션은 지금 가격에 전량 정리돼요)' : '(잠정 후보라 취소해도 신호는 나가지 않아요)';
  const tail = auto ? `\n⏱ ${settings.graceMin}분 안에 '무시' 를 누르지 않으면 자동으로 취소·정리해요` : '';
  const keep = { text: '무시', callback_data: auto ? `cnt:keep:${coin}:${tf}` : 'cnt:ignore:-' };
  const head = `🚨 ${coin} · ${tf} — ${broken.seq}번 저점(${fmtPx(broken.low)}) 아래로 마감 (${fmtPx(close)} · ${when} KST 봉)`;
  const msgId = broken.seq === 1
    ? await deps.send(`${head}\n카운트를 어떻게 할까요?\n${effect}${tail}`, [[{ text: '🗑 전체 취소', callback_data: `cnt:reset:${coin}:${tf}` }, keep]])
    : await deps.send(`${head}\n${broken.seq}번부터 취소할까요? (1번은 유지)\n${effect}${tail}`, [[{ text: `🗑 ${broken.seq}부터 취소`, callback_data: `cnt:cancel:${coin}:${tf}:${broken.seq}` }, keep]]);
  await store.setBreakMs(db, coin, tf, streakStart); // 발송 성공 후에만 전진
  if (auto) await store.setPendingBreak(db, coin, tf, broken.seq, deps.now(), msgId);
}

async function sendProposal(db: D1Database, coin: string, tf: string, closed: Candle[], ci: number, decision: { action: string; seq: number | null }, chain: store.CountRow[], deps: MonitorDeps, settings: store.BotSettings): Promise<void> {
  const cand = closed[ci];
  const when = kst(cand.t);
  if (decision.action === 'propose_reanchor') {
    await sendWithChart(deps, coin, tf, closed, [...chain.map((e) => ({ tsMs: e.tsMs, label: String(e.seq) })), { tsMs: cand.t, label: 'NEW LOW' }],
      `🔻 ${coin} · ${tf} — 1번(바닥 리테스트)보다 낮은 저점 확정 (${fmtPx(cand.l)} · ${when} KST)\n바닥이 갱신됐어요. 카운트를 리셋하고 새 바닥의 리테스트(1)를 기다릴까요?\n(바닥 자체는 1이 아니라서 이 저점을 1로 지정하진 않아요)`,
      [[{ text: '🗑 리셋하고 재탐색', callback_data: `cnt:reset:${coin}:${tf}` }, { text: '무시', callback_data: 'cnt:ignore:-' }]],
    );
    return;
  }
  const seq = decision.seq!;
  const id = await store.addCount(db, coin, tf, seq, cand.t, cand.l);
  let text = `📉 ${coin} · ${tf} — ${seq}번 저점 후보 (${fmtPx(cand.l)} · ${when} KST) · 잠정 인정\n현재 카운트: ${chain.map((e) => e.seq).join(' → ') || '없음'} → ${seq}`;
  // 진짜 리테스트는 조용히 온다 — 거래량 급증 후보는 경고 배지만
  if (ci >= 20) {
    let sum = 0; for (let j = ci - 20; j < ci; j++) sum += closed[j].v;
    const avg = sum / 20;
    if (avg > 0 && cand.v / avg >= VOL_SPIKE_MULT) text += `\n⚠️ 거래량 ${(cand.v / avg).toFixed(1)}× 급증 — 진짜 리테스트는 보통 조용해요`;
  }
  text += seq === 1 ? '\n✅ 누르면 AI 자동매매 사용자 전원이 오른다에 걸어요' : '\n✅ 누르면 AI 자동매매 사용자 전원이 불타기(추가 진입)해요';
  if (seq >= 2 && store.autoEligible(settings, tf, chain)) text += `\n⏱ ${settings.graceMin}분 안에 ❌ 를 누르지 않으면 자동으로 확정·불타기해요`;
  try {
    const msgId = await sendWithChart(deps, coin, tf, closed, [...chain.map((e) => ({ tsMs: e.tsMs, label: String(e.seq) })), { tsMs: cand.t, label: String(seq) }], text,
      [[{ text: `✅ ${seq} 맞아`, callback_data: `cnt:ok:${id}` }, { text: `❌ ${seq} 아니야`, callback_data: `cnt:no:${id}` }]]);
    await store.setCountMsgId(db, id, msgId);
  } catch (e) {
    await store.setCountStatus(db, id, 'cancelled'); // 유령 카운트를 남기지 않고 재시도 위임
    throw e;
  }
}

/** 📍 수동 지정 직후 소급 스캔 — 지정 봉 이후의 확정 피봇에서 다음 카운트 후보를 최대 3개 제안 (hlbot _backfill_counts). 제안 수 반환 */
export async function backfillAfter(db: D1Database, coin: string, tf: string, fromMs: number, deps: MonitorDeps, max = 3): Promise<number> {
  const closed = closedOnly(await deps.fetchCandles(coin, tf, EVAL_BARS), tf, deps.now());
  if (closed.length < 30) return 0;
  const ema28 = ema(closed.map((k) => k.c), 28);
  const settings = await store.getBotSettings(db);
  const vetoed = new Set(((await db.prepare("SELECT ts_ms FROM bot_counts WHERE coin = ? AND tf = ? AND status = 'vetoed'").bind(coin, tf).all<{ ts_ms: number }>()).results ?? []).map((r) => r.ts_ms));
  let sent = 0;
  for (const ci of findPivotLows(closed, PIVOT_W, PIVOT_W)) {
    if (sent >= max) break;
    const cand = closed[ci];
    if (cand.t <= fromMs || vetoed.has(cand.t)) continue;
    const chain = await store.activeChain(db, coin, tf);
    if (chain.length && cand.l < chain[0].low) break; // 앵커가 깨진 뒤의 2·3 제안은 구조 위반 — 중단
    let barGap = 999;
    if (chain.length) { const lastI = closed.findIndex((k) => k.t === chain[chain.length - 1].tsMs); if (lastI >= 0) barGap = ci - lastI; }
    const decision = decide(chain, { tsMs: cand.t, low: cand.l }, barGap);
    if (decision.action !== 'propose') continue; // 재앵커 제안은 생략 — 방금 사용자가 직접 지정했으므로
    if (decision.seq === 1 && (cand.l > ema28[ci] * EMA_TOUCH_TOL || !isRetestLow(closed, ci, tf))) continue;
    await sendProposal(db, coin, tf, closed, ci, decision, chain, deps, settings);
    sent++;
  }
  return sent;
}

/** 차트 사진으로 보내고, 차트를 못 만들거나 사진 발송이 안 되면 글자로 보낸다 (알림 자체는 절대 빠지지 않게) */
export async function sendWithChart(deps: MonitorDeps, coin: string, tf: string, fallbackCandles: Candle[], markers: ChartMarker[], text: string, keyboard?: InlineKeyboard | null): Promise<number> {
  if (deps.sendPhoto) {
    try {
      const candles = await deps.fetchCandles(coin, tf, CHART_BARS).then((k) => closedOnly(k, tf, deps.now())).catch(() => fallbackCandles);
      const png = await renderChartPng({ coin, tf, candles, markers, displayBars: DISPLAY_BARS });
      return await deps.sendPhoto(png, text, keyboard);
    } catch { /* 아래 글자 발송으로 */ }
  }
  return deps.send(text, keyboard);
}

/** 관리자 화면·/count 용: 최근 피봇 저점 목록 (수동 1·2·3 지정 후보) */
export async function recentPivots(coin: string, tf: string, deps: Pick<MonitorDeps, 'fetchCandles' | 'now'>, afterMs = 0, max = 6): Promise<{ tsMs: number; low: number }[]> {
  const closed = closedOnly(await deps.fetchCandles(coin, tf, EVAL_BARS), tf, deps.now());
  return findPivotLows(closed, PIVOT_W, PIVOT_W).map((i) => ({ tsMs: closed[i].t, low: closed[i].l })).filter((p) => p.tsMs > afterMs).slice(-max).reverse();
}
export { intervalMs };
