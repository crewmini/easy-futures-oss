// hlbot tests/test_monitor.py 이식 — D1(workerd) + 가짜 캔들·가짜 발송
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as store from './db.js';
import { pollOnce, type MonitorDeps } from './monitor.js';
import type { Candle } from './strategy.js';

const STEP = 15 * 60_000;
const T0 = 1_700_000_000_000 - 239 * STEP;
const db = () => env.DB;
function mk(lows: number[]): Candle[] { return lows.map((x, i) => ({ t: T0 + i * STEP, o: x + 5, h: x + 10, l: x, c: x + 5, v: 1 })); }
function pivotAtTarget(n = 240): Candle[] { const l = Array(n).fill(100); l[n - 40] = 89; l[n - 6] = 90; return mk(l); }
interface Sent { text: string; datas: string[] }
function deps(candles: Candle[] | (() => Candle[]), sent: Sent[], opts: { fail?: boolean } = {}): MonitorDeps {
  const get = typeof candles === 'function' ? candles : () => candles;
  return {
    fetchCandles: async () => get(),
    send: async (text, kb) => { if (opts.fail) throw new Error('telegram down'); sent.push({ text, datas: (kb ?? []).flat().map((b) => b.callback_data) }); return 1000 + sent.length; },
    now: () => get()[get().length - 1].t + STEP + 1000, // 마지막 봉 마감 직후
  };
}
async function reset() {
  await db().batch([db().prepare('DELETE FROM bot_counts'), db().prepare('DELETE FROM bot_watch_state'), db().prepare('DELETE FROM bot_watchlist'), db().prepare('DELETE FROM bot_settings')]);
  await store.addWatch(db(), 'BTC', ['15m']);
}
async function confirmed(k: Candle[], i: number, seq = 1, low?: number) {
  const id = await store.addCount(db(), 'BTC', '15m', seq, k[i].t, low ?? k[i].l);
  await store.setCountStatus(db(), id, 'confirmed');
}

describe('bottom bot monitor', () => {
  beforeEach(reset);

  it('pivot proposes count 1', async () => {
    const sent: Sent[] = []; await pollOnce(db(), deps(pivotAtTarget(), sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]);
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain('1번 저점 후보');
    expect(sent[0].datas[0]).toMatch(/^cnt:ok:\d+$/);
    expect((await store.activeChain(db(), 'BTC', '15m'))[0].msgId).toBe(1001);
  });

  it('close below anchor alerts immediately, chain kept', async () => {
    const l = Array(240).fill(100); l[200] = 90; l[239] = 80; const k = mk(l);
    await confirmed(k, 200);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain('1번 저점'); expect(sent[0].text).toContain('아래로 마감');
    expect(sent[0].datas).toContain('cnt:reset:BTC:15m');
    expect(await store.activeChain(db(), 'BTC', '15m')).toHaveLength(1);
  });

  it('wick below anchor no alert', async () => {
    const l = Array(240).fill(100); l[200] = 90; l[239] = 85; const k = mk(l); k[239].c = 95;
    await confirmed(k, 200);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(sent).toHaveLength(0);
  });

  it('break alert once per streak, missed crossing still alerts once', async () => {
    const l = Array(240).fill(100); l[200] = 90; l[238] = 80; l[239] = 80; const k = mk(l);
    await confirmed(k, 200);
    const sent: Sent[] = []; const d = deps(k, sent);
    await pollOnce(db(), d); await pollOnce(db(), d);
    expect(sent).toHaveLength(1);
  });

  it('auto-eligible chain: break registers a pending auto-close with a keep button; proposal 2 carries the grace note', async () => {
    const l = Array(240).fill(100); l[180] = 80; l[200] = 92; l[239] = 85; const k = mk(l);
    await confirmed(k, 180, 1); await confirmed(k, 200, 2);
    await db().prepare("UPDATE bot_counts SET signal_id = 'bot-btc-15m-x-1' WHERE seq = 1").run();
    const sent: Sent[] = []; const d = deps(k, sent); await pollOnce(db(), d);
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain('3분 안에'); expect(sent[0].text).toContain('전량 정리');
    expect(sent[0].datas).toEqual(['cnt:cancel:BTC:15m:2', 'cnt:keep:BTC:15m']);
    expect(await store.listDueBreaks(db(), d.now())).toEqual([{ coin: 'BTC', tf: '15m', seq: 2, at: d.now(), msgId: 1001 }]);
    // 2번 후보 제안에 자동 확정 안내
    await db().batch([db().prepare('DELETE FROM bot_counts'), db().prepare('DELETE FROM bot_watch_state')]);
    const l2 = Array(240).fill(100); l2[150] = 80; l2[200] = 90; l2[234] = 95; const k2 = mk(l2);
    await confirmed(k2, 200, 1);
    await db().prepare("UPDATE bot_counts SET signal_id = 'bot-btc-15m-x-1' WHERE seq = 1").run();
    const sent2: Sent[] = []; await pollOnce(db(), deps(k2, sent2));
    expect(sent2).toHaveLength(1); expect(sent2[0].text).toContain('2번 저점 후보'); expect(sent2[0].text).toContain('자동으로 확정');
    // 1번이 수동 지정(신호 없음)이면 안내 없음
    await db().batch([db().prepare('DELETE FROM bot_counts'), db().prepare('DELETE FROM bot_watch_state')]);
    await confirmed(k2, 200, 1);
    const sent3: Sent[] = []; await pollOnce(db(), deps(k2, sent3));
    expect(sent3[0].text).not.toContain('자동으로 확정');
  });

  it('close below count 2 offers partial cancel', async () => {
    const l = Array(240).fill(100); l[180] = 80; l[200] = 92; l[239] = 85; const k = mk(l);
    await confirmed(k, 180, 1); await confirmed(k, 200, 2);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain('2번 저점'); expect(sent[0].text).toContain('1번은 유지');
    expect(sent[0].datas).toContain('cnt:cancel:BTC:15m:2');
  });

  it('count 1 far above bottom zone filtered (watermark advances)', async () => {
    const l = Array(240).fill(100); l[120] = 80; l[234] = 90;
    const sent: Sent[] = []; await pollOnce(db(), deps(mk(l), sent));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]); expect(sent).toHaveLength(0);
    expect(await store.getWatermark(db(), 'BTC', '15m')).toBeGreaterThan(0);
  });

  it('fresh deep low not proposed as count 1', async () => {
    const l = Array(240).fill(100); l[234] = 90;
    const sent: Sent[] = []; await pollOnce(db(), deps(mk(l), sent));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]); expect(sent).toHaveLength(0);
  });

  it('count 1 right after bottom (no bounce) filtered', async () => {
    const l = Array(240).fill(100); l[225] = 89; l[234] = 89.3; const k = mk(l); for (let i = 225; i < 240; i++) k[i].h = 90;
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]); expect(sent).toHaveLength(0);
  });

  it('retest after enough bars proposed', async () => {
    const l = Array(240).fill(100); l[210] = 89; l[234] = 90;
    const sent: Sent[] = []; await pollOnce(db(), deps(mk(l), sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]); expect(sent).toHaveLength(1);
  });

  it('count 2 not blocked by bottom zone', async () => {
    const l = Array(240).fill(100); l[210] = 80; l[234] = 90; const k = mk(l);
    await confirmed(k, 210, 1, 80);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1, 2]);
    expect(sent[0].text).toContain('2번 저점 후보'); expect(sent[0].text).toContain('불타기');
  });

  it('volume spike badge only on spikes', async () => {
    const k = pivotAtTarget(); k[234].v = 5;
    let sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(sent[0].text).toContain('거래량'); expect(sent[0].text).toContain('급증');
    await reset(); sent = []; await pollOnce(db(), deps(pivotAtTarget(), sent));
    expect(sent[0].text).not.toContain('거래량');
  });

  it('watermark prevents duplicate', async () => {
    const sent: Sent[] = []; const d = deps(pivotAtTarget(), sent);
    await pollOnce(db(), d); await pollOnce(db(), d);
    expect(await store.activeChain(db(), 'BTC', '15m')).toHaveLength(1); expect(sent).toHaveLength(1);
  });

  it('non-pivot advances watermark silently', async () => {
    const sent: Sent[] = []; await pollOnce(db(), deps(mk(Array(240).fill(100)), sent));
    expect(sent).toHaveLength(0); expect(await store.getWatermark(db(), 'BTC', '15m')).toBeGreaterThan(0);
  });

  it('low above ema ignored', async () => {
    const n = 240; const l = [...Array(n - 16).fill(100), ...Array(16).fill(150)]; l[n - 6] = 148;
    const sent: Sent[] = []; await pollOnce(db(), deps(mk(l), sent));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]);
  });

  it('reanchor sends explicit prompt without touching chain', async () => {
    await store.addCount(db(), 'BTC', '15m', 1, 1, 95);
    const sent: Sent[] = []; await pollOnce(db(), deps(pivotAtTarget(), sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.low)).toEqual([95]);
    expect(sent[0].text).toContain('리셋'); expect(sent[0].datas).toContain('cnt:reset:BTC:15m');
  });

  it('fetch error skips combo and records error', async () => {
    const sent: Sent[] = [];
    await pollOnce(db(), { fetchCandles: async () => { throw new Error('캔들 없음'); }, send: async () => 1, now: () => Date.now() });
    expect(sent).toHaveLength(0);
    expect((await store.listWatchState(db()))[0].lastError).toContain('캔들 없음');
  });

  it('send failure rolls back and keeps watermark', async () => {
    const sent: Sent[] = [];
    await pollOnce(db(), deps(pivotAtTarget(), sent, { fail: true }));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]);
    expect(await store.getWatermark(db(), 'BTC', '15m')).toBe(0);
    await pollOnce(db(), deps(pivotAtTarget(), sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]);
  });

  it('downtime gap: all pivots evaluated in order', async () => {
    const l = Array(240).fill(100); l[150] = 89; l[200] = 90; l[220] = 91; const k = mk(l);
    await store.setWatermark(db(), 'BTC', '15m', k[190].t);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1, 2]); expect(sent).toHaveLength(2);
  });

  it('completed chain: new cycle prompt', async () => {
    const l = Array(240).fill(100); l[60] = 89; l[90] = 90; l[110] = 90.5; l[130] = 91; l[234] = 91.5; const k = mk(l);
    await confirmed(k, 90, 1, 90); await confirmed(k, 110, 2, 90.5); await confirmed(k, 130, 3, 91);
    await store.setWatermark(db(), 'BTC', '15m', k[200].t);
    const sent: Sent[] = []; await pollOnce(db(), deps(k, sent));
    expect(await store.activeChain(db(), 'BTC', '15m')).toHaveLength(3);
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain('새 사이클'); expect(sent[0].datas).toContain('cnt:reset:BTC:15m:nc');
  });
});
