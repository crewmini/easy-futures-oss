// 저점 봇 → AI 자동매매 실행 연결. 텔레그램에서 사람이 확정한 뒤에만 호출된다.
// /api/signals(HMAC) 와 같은 경로(insertSignal → AutoTrader DO)를 서버 안에서 직접 탄다.
import type { AutoSignal, Symbol } from '@easy-futures/shared';
import { finishSignal, insertSignal } from '../auto/db.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { PaperClient } from '../paper/client.js';
import { getBotSettings, type BotSettings } from './db.js';
import { fmtPx } from './telegram.js';

export const COIN_SYMBOL: Record<string, Symbol> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
export const SL_ANCHOR_FACTOR = 0.995; // 손절 = 저점 저가 × 0.995 (hlbot 과 동일)

export interface RunResult { followers: number; ok: number; fail: number; skipped: number }
export interface Emitted { signal: AutoSignal; summary: string; run: () => Promise<RunResult> }
export interface Skipped { skipped: string }
export type EmitResult = Emitted | Skipped;
export const isSkipped = (r: EmitResult | null): r is Skipped => !!r && 'skipped' in r;

type Draft = Pick<AutoSignal, 'id' | 'symbol' | 'action'> & Partial<Pick<AutoSignal, 'direction' | 'leverage' | 'slPrice' | 'tpPrice' | 'breakeven' | 'note'>>;

async function runSignal(env: Env, id: string): Promise<RunResult> {
  const stub = env.AUTO.get(env.AUTO.idFromName('global'));
  const r = await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: id }), headers: { 'content-type': 'application/json' } });
  if (!r.ok) { log.warn('bot signal run failed', { id, status: r.status }); await finishSignal(env.DB, id, 0, 0, 0).catch(() => {}); return { followers: 0, ok: 0, fail: 0, skipped: 0 }; }
  return (await r.json()) as RunResult;
}

/** 신호 저장 후 실행 함수를 돌려준다. 안 보내는 경우엔 이유를 돌려준다 (텔레그램에 한 줄로 보인다) */
export async function emit(env: Env, coin: string, draft: Omit<Draft, 'symbol'>, settings?: BotSettings): Promise<EmitResult> {
  const symbol = COIN_SYMBOL[coin.toUpperCase()];
  if (!symbol) return { skipped: `${coin} 은 Easy futures 미지원 종목 — 신호 안 보냄` };
  const s = settings ?? (await getBotSettings(env.DB));
  if (!s.relay) return { skipped: 'AI 자동매매 연결이 꺼져 있어 신호 안 보냄 (/bot on)' };
  const signal: AutoSignal = {
    id: draft.id, source: 'bot', symbol, action: draft.action, direction: draft.direction ?? null, leverage: draft.leverage ?? null,
    slRoi: null, tpRoi: null, slPrice: draft.slPrice ?? null, tpPrice: draft.tpPrice ?? null, breakeven: draft.breakeven ?? false,
    note: (draft.note ?? '').slice(0, 200) || null, createdAt: Date.now(), processedAt: null, followerCount: null, okCount: null, failCount: null,
  };
  const inserted = await insertSignal(env.DB, signal);
  if (!inserted) { log.info('bot signal duplicate', { id: signal.id }); return { skipped: '이미 보낸 신호예요 (같은 봉·같은 번호) — 다시 보내지 않았어요' }; }
  log.info('bot signal', { id: signal.id, symbol, action: signal.action, note: signal.note });
  const parts = [`${symbol} ${signal.note ?? signal.action}`];
  if (signal.action === 'open' || signal.action === 'add') parts.push(`${signal.direction === 'long' ? '오른다' : '내린다'} ${signal.leverage}배`);
  if (signal.slPrice) parts.push(`손절 ${fmtPx(signal.slPrice)}`);
  if (signal.tpPrice) parts.push(`익절 ${fmtPx(signal.tpPrice)}`);
  if (signal.breakeven) parts.push('본절');
  return { signal, summary: parts.join(' · '), run: () => runSignal(env, signal.id) };
}

/** ✅ N 맞아: 1번 = open 롱, 2·3번 = add(불타기). 손절 저점×0.995, 익절 = 현재가 + 손절거리 × R */
export async function emitEntry(env: Env, coin: string, tf: string, seq: number, tsMs: number, low: number): Promise<EmitResult> {
  const s = await getBotSettings(env.DB);
  if (s.tfs.length && !s.tfs.includes(tf)) return { skipped: `${tf} 봉은 신호 대상이 아니에요 (/bot tfs 로 설정) — 카운트만 확정` };
  const slPrice = round(low * SL_ANCHOR_FACTOR);
  // 지금 가격이 이미 손절가(저점×0.995) 아래면 저점이 깨진 뒤 — 진입 신호를 보내지 않는다 (감사 전략 H3)
  const px = await currentPrice(env, coin).catch(() => 0);
  if (px > 0 && px <= slPrice) return { skipped: `지금 가격(${fmtPx(px)})이 손절가(${fmtPx(slPrice)}) 아래예요 — 저점이 깨져 진입 신호를 보내지 않았어요` };
  let tpPrice: number | null = null;
  if (s.tpR > 0 && px > slPrice) tpPrice = round(px + (px - slPrice) * s.tpR);
  const label = seq === 1 ? '1번 저점 진입' : `${seq}번 저점 불타기`;
  return emit(env, coin, { id: `bot-${coin.toLowerCase()}-${tf}-${tsMs}-${seq}`, action: seq === 1 ? 'open' : 'add', direction: 'long', leverage: s.leverage, slPrice, tpPrice, note: `${label} (${tf})` }, s);
}
export function emitBreakeven(env: Env, coin: string, note: string, key = String(Date.now())): Promise<EmitResult> {
  return emit(env, coin, { id: `bot-${coin.toLowerCase()}-be-${key}`, action: 'update', breakeven: true, note });
}
export function emitClose(env: Env, coin: string, note: string, key = String(Date.now())): Promise<EmitResult> {
  return emit(env, coin, { id: `bot-${coin.toLowerCase()}-close-${key}`, action: 'close', note });
}
export function emitUpdate(env: Env, coin: string, upd: { slPrice?: number; tpPrice?: number }, note: string): Promise<EmitResult> {
  return emit(env, coin, { id: `bot-${coin.toLowerCase()}-upd-${Date.now()}`, action: 'update', slPrice: upd.slPrice, tpPrice: upd.tpPrice, note });
}
export function resultLine(r: RunResult & { dup?: boolean }): string {
  if (r.dup) return '이미 실행 중인 신호예요';
  return r.followers === 0 ? 'AI 자동매매 대상 없음 (승인+켬 사용자 0명)' : `AI 자동매매 ${r.followers}명 → 성공 ${r.ok} · 실패 ${r.fail} · 건너뜀 ${r.skipped}`;
}

export interface ExecLine { loginId: string; mode: 'paper' | 'live'; status: 'ok' | 'failed' | 'skipped'; detail: string | null }
const STATUS_LABEL: Record<ExecLine['status'], string> = { ok: '✅ 성공', failed: '❌ 실패', skipped: '⏭ 건너뜀' };
const STATUS_RANK: Record<ExecLine['status'], number> = { ok: 0, failed: 1, skipped: 2 };
const TG_MAX = 3_800; // 텔레그램 한 메시지 4096자 — 여유를 두고 나눈다

/** 결과 메시지: 첫 줄 요약 + 사용자별 한 줄(성공 → 실패 → 건너뜀 순, 사유 포함). 길면 여러 메시지로 나눈다 */
export function resultReport(head: string, r: RunResult & { dup?: boolean }, execs: ExecLine[]): string[] {
  const first = `${head} → ${resultLine(r)}`;
  if (r.dup || execs.length === 0) return [first];
  const sorted = [...execs].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const lines = sorted.map((e, i) => `${i + 1}. ${e.loginId}님 ${STATUS_LABEL[e.status]}${e.mode === 'paper' ? ' (연습)' : ''}${e.detail ? ` — ${e.detail}` : ''}`);
  const out: string[] = []; let cur = first;
  for (const l of lines) {
    if (cur.length + 1 + l.length > TG_MAX) { out.push(cur); cur = l; } else cur += `\n${l}`;
  }
  out.push(cur);
  return out;
}

async function currentPrice(env: Env, coin: string): Promise<number> {
  const symbol = COIN_SYMBOL[coin.toUpperCase()];
  const pr = await new PaperClient(env).prices();
  return pr.prices[symbol]?.mark || pr.prices[symbol]?.last || 0;
}
function round(v: number): number { return Number(v.toPrecision(10)); }
