// 텔레그램 웹훅·버튼 → 카운트 상태 → 자동매매 신호 (workerd 안, 텔레그램·캔들 API 는 fetchMock)
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { net } from './net.js';
import * as store from './db.js';
import { handleUpdate, processDue } from './webhook.js';
import { Telegram, webhookHeaderSecret, webhookSecret, type TgUpdate } from './telegram.js';
import type { Candle } from './strategy.js';
import { AUTO_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { applyAuto, saveAutoSettings, setAutoStatus } from '../auto/db.js';
import { resultReport } from './signals.js';

/** 승인 + 켬 상태의 연습 팔로워 (비율 pct%) */
async function mkFollower(loginId: string, uid: string, pct: number) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  await applyAuto(env.DB, u.id, { enabled: true, pct, maxLeverage: 10, defaultSlRoi: 20 }, AUTO_TERMS_VERSION);
  await setAutoStatus(env.DB, u.id, 'approved', 'admin', null);
  await saveAutoSettings(env.DB, u.id, { enabled: true, pct, maxLeverage: 10, defaultSlRoi: 20 }); // 승인 뒤 사용자가 켬
  return u.id;
}

const STEP = 15 * 60_000;
interface Call { method: string; body: Record<string, unknown> }
let calls: Call[] = [];
let candles: Candle[] = [];
const tg = new Telegram('test-token', 'https://telegram.test');
const db = () => env.DB;

function mk(lows: number[], t0 = Date.now() - 240 * STEP): Candle[] { return lows.map((x, i) => ({ t: t0 + i * STEP, o: x + 5, h: x + 10, l: x, c: x + 5, v: 1 })); }
const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
const lastKb = () => { const m = [...calls].reverse().find((c) => c.method === 'sendMessage' && c.body.reply_markup); return ((m?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })?.inline_keyboard ?? []).flat().map((b) => b.callback_data); };
async function signals() { return (await db().prepare('SELECT id, symbol, action, direction, leverage, sl_price, tp_price, breakeven, note FROM auto_signals ORDER BY created_at, id').all()).results as Record<string, unknown>[]; }
async function run(update: TgUpdate) { const tasks: Promise<unknown>[] = []; await handleUpdate(env, tg, update, (p) => tasks.push(p)); await Promise.all(tasks); }
let uid = 1000;
const msg = (text: string, chat = 42): TgUpdate => ({ update_id: ++uid, message: { message_id: 7, chat: { id: chat }, from: { id: chat }, text } });
const cb = (data: string, chat = 42): TgUpdate => ({ update_id: ++uid, callback_query: { id: 'q1', data, from: { id: chat }, message: { message_id: 9, chat: { id: chat }, text: '원문' } } });
async function injectPrices() { await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }) }); }

beforeAll(() => {
  net.fetch = async (url, init) => {
    if (url.startsWith('https://telegram.test/bottest-token/')) {
      const method = url.split('/').pop()!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: '' } : { message_id: 100 + calls.length } });
    }
    if (url === 'https://candles.test/info') return Response.json(candles.map((k) => ({ t: k.t, o: String(k.o), h: String(k.h), l: String(k.l), c: String(k.c), v: String(k.v) })));
    throw new Error(`unexpected fetch ${url}`);
  };
});
beforeEach(async () => {
  calls = [];
  await db().batch([db().prepare('DELETE FROM bot_counts'), db().prepare('DELETE FROM bot_watch_state'), db().prepare('DELETE FROM bot_watchlist'), db().prepare('DELETE FROM bot_settings'), db().prepare('DELETE FROM auto_signals'), db().prepare('DELETE FROM auto_executions')]);
});

describe('telegram webhook route', () => {
  it('rejects wrong secret, accepts derived secret + header', async () => {
    const secret = await webhookSecret('test-token'); const header = await webhookHeaderSecret('test-token');
    let r = await SELF.fetch('http://localhost/api/telegram/wrong', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    r = await SELF.fetch(`http://localhost/api/telegram/${secret}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret } });
    expect(r.status).toBe(401); // 경로 값만으로는(=헤더에 경로 값) 위조 불가
    const u = msg('/start', 7);
    r = await SELF.fetch(`http://localhost/api/telegram/${secret}`, { method: 'POST', body: JSON.stringify(u), headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': header } });
    expect(r.status).toBe(200);
    r = await SELF.fetch(`http://localhost/api/telegram/${secret}`, { method: 'POST', body: JSON.stringify(u), headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': header } });
    expect(await r.json()).toMatchObject({ dup: true }); // 같은 update_id 재전달은 무시
    expect(texts().some((t) => t.includes('chat_id: 7') && t.includes('관리자만'))).toBe(true);
  });
});

describe('commands', () => {
  it('/watch registers and kicks the engine; unsupported coin gets a note', async () => {
    await run(msg('/watch BTC 15m 1h'));
    expect(await store.listWatches(db())).toEqual({ BTC: ['15m', '1h'] });
    expect(texts()[0]).toContain('감시 시작');
    await run(msg('/watch UNI'));
    expect(texts()[1]).toContain('미지원');
    await run(msg('/watch BTC 7m'));
    expect(texts()[2]).toContain('지원하지 않는');
    await run(msg('/unwatch UNI'));
    expect(await store.listWatches(db())).toEqual({ BTC: ['15m', '1h'] });
  });
  it('/status and /bot settings', async () => {
    await store.addWatch(db(), 'BTC', ['15m']);
    await run(msg('/status'));
    expect(texts()[0]).toContain('BTC · 15m');
    await run(msg('/bot off')); await run(msg('/bot lev 5')); await run(msg('/bot tpr 2')); await run(msg('/bot tfs 15m 1h')); await run(msg('/bot auto off')); await run(msg('/bot grace 5'));
    expect(await store.getBotSettings(db())).toEqual({ relay: false, leverage: 5, tpR: 2, tfs: ['15m', '1h'], autoConfirm: false, graceMin: 5 });
    await run(msg('/bot grace 99'));
    expect(texts().at(-1)).toContain('1~30');
    await run(msg('/bot lev 500'));
    expect(texts().at(-1)).toContain('1~50');
    await run(msg('/bot on')); await run(msg('/bot tfs all'));
    expect((await store.getBotSettings(db())).tfs).toEqual([]);
  });
  it('ignores non-admin messages and callbacks', async () => {
    await run(msg('/watch BTC', 7));
    expect(await store.listWatches(db())).toEqual({});
    const id = await store.addCount(db(), 'BTC', '15m', 1, 1, 100);
    await run(cb(`cnt:ok:${id}`, 7));
    expect((await store.activeChain(db(), 'BTC', '15m'))[0].status).toBe('proposed');
  });
});

describe('count buttons → auto-trading signals', () => {
  it('✅ 1 → open long with sl/tp; retap blocked; ✅ 2 → add', async () => {
    await injectPrices();
    const k = mk(Array(240).fill(60_000)); k[200].l = 59_000;
    const id1 = await store.addCount(db(), 'BTC', '15m', 1, k[200].t, 59_000);
    await run(cb(`cnt:ok:${id1}`));
    expect((await store.activeChain(db(), 'BTC', '15m'))[0].status).toBe('confirmed');
    let s = await signals();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: `bot-btc-15m-${k[200].t}-1`, symbol: 'BTCUSDT', action: 'open', direction: 'long', leverage: 3, sl_price: 59_000 * 0.995 });
    expect(s[0].tp_price).toBeCloseTo(80_000 + (80_000 - 59_000 * 0.995) * 1.5, 3);
    expect(texts().some((t) => t.includes('📡') && t.includes('1번 저점 진입'))).toBe(true);
    expect(texts().some((t) => t.includes('자동매매 대상 없음'))).toBe(true);
    await run(cb(`cnt:ok:${id1}`));
    expect(await signals()).toHaveLength(1);
    expect(calls.some((c) => c.method === 'answerCallbackQuery' && String(c.body.text).includes('이미 처리'))).toBe(true);
    const id2 = await store.addCount(db(), 'BTC', '15m', 2, k[220].t, 59_500);
    await run(cb(`cnt:ok:${id2}`));
    s = await signals();
    expect(s[1]).toMatchObject({ action: 'add', note: '2번 저점 불타기 (15m)' });
  });
  it('result message lists every follower with status and reason', async () => {
    await injectPrices();
    await env.DB.prepare("DELETE FROM users WHERE login_id IN ('tgline01', 'tgline02')").run();
    await mkFollower('tgline01', '91234101', 30); // 1000 USDT × 30% = 300 → 1계약(≈27 USDT 증거금) 진입 가능
    await mkFollower('tgline02', '91234102', 1); // 10 USDT → 1계약도 못 사서 건너뜀
    const k = mk(Array(240).fill(60_000)); k[200].l = 59_000;
    const id1 = await store.addCount(db(), 'BTC', '15m', 1, k[200].t, 59_000);
    await run(cb(`cnt:ok:${id1}`));
    const res = texts().find((t) => t.includes('AI 자동매매 2명'))!;
    expect(res).toBeDefined();
    const lines = res.split('\n');
    expect(lines[0]).toContain('성공 1 · 실패 0 · 건너뜀 1');
    expect(lines[1]).toMatch(/^1\. tgline01님 ✅ 성공 \(연습\) — .*오른다 .* 3배 \(\d+계약\)/);
    expect(lines[2]).toMatch(/^2\. tgline02님 ⏭ 건너뜀 \(연습\) — 금액이 너무 적음/);
  });
  it('❌ vetoes and cancels later counts, no signal', async () => {
    const id1 = await store.addCount(db(), 'BTC', '15m', 1, 1, 100);
    await store.addCount(db(), 'BTC', '15m', 2, 2, 101);
    await run(cb(`cnt:no:${id1}`));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]);
    expect(await signals()).toHaveLength(0);
  });
  it('cancel/reset of confirmed lows → close at market; proposed-only cancel → no signal; new-cycle reset → breakeven', async () => {
    await store.addCount(db(), 'BTC', '15m', 1, 1, 100, 'confirmed'); await store.addCount(db(), 'BTC', '15m', 2, 2, 101, 'confirmed'); await store.addCount(db(), 'BTC', '15m', 3, 3, 102);
    await run(cb('cnt:cancel:BTC:15m:3')); // 잠정 3만 취소 → 신호 없음
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1, 2]);
    expect(await signals()).toHaveLength(0);
    expect(texts().concat(calls.filter((c) => c.method === 'editMessageText').map((c) => String(c.body.text))).some((t) => t.includes('확정 저점이 아니라 신호는 없어요'))).toBe(true);
    await run(cb('cnt:cancel:BTC:15m:2')); // 확정 2 취소 → 전량 정리
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]);
    await run(cb('cnt:reset:BTC:15m'));
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]);
    await store.addCount(db(), 'ETH', '1h', 1, 1, 100, 'confirmed');
    await run(cb('cnt:reset:ETH:1h:nc'));
    const s = await signals();
    expect(s.map((x) => [x.symbol, x.action, x.breakeven, x.note])).toEqual([['BTCUSDT', 'close', 0, '2번 저점 이탈 → 전량 정리 (15m)'], ['BTCUSDT', 'close', 0, '1번 저점 이탈 → 전량 정리 (15m)'], ['ETHUSDT', 'update', 1, '새 사이클 리셋 → 본절 (1h)']]);
  });
  it('relay off or unsupported coin → no signal, tf filter respected', async () => {
    await store.setBotSetting(db(), 'relay', 'off');
    const id = await store.addCount(db(), 'BTC', '15m', 1, 1, 100);
    await run(cb(`cnt:ok:${id}`));
    expect(await signals()).toHaveLength(0);
    await store.setBotSetting(db(), 'relay', 'on');
    const u = await store.addCount(db(), 'UNI', '15m', 1, 1, 8);
    await run(cb(`cnt:ok:${u}`));
    await store.setBotSetting(db(), 'tfs', '1h');
    const b = await store.addCount(db(), 'BTC', '15m', 1, 5, 100);
    await run(cb(`cnt:ok:${b}`));
    expect(await signals()).toHaveLength(0);
    expect((await store.getCount(db(), b))?.status).toBe('confirmed'); // 카운트 확정은 되고 신호만 안 나감
  });
  it('/close, /be, /panic', async () => {
    await run(msg('/close BTC')); await run(msg('/be ETH'));
    await run(msg('/panic'));
    expect(lastKb()).toContain('bot:panic_yes');
    await run(cb('bot:panic_yes'));
    const s = await signals();
    expect(s.map((x) => [x.symbol, x.action])).toEqual([['BTCUSDT', 'close'], ['ETHUSDT', 'update'], ['BTCUSDT', 'close'], ['ETHUSDT', 'close'], ['SOLUSDT', 'close']]);
    await run(msg('/close UNI'));
    expect(texts().at(-1)).toContain('사용법');
  });
  it('📍 pick lists recent pivots and set designates manually without signal', async () => {
    const l = Array(240).fill(100); l[100] = 90; l[150] = 92; l[200] = 95; candles = mk(l);
    await run(msg('/count BTC 15m'));
    expect(lastKb()).toContain('cnt:pick:BTC:15m:1');
    await run(cb('cnt:pick:BTC:15m:1'));
    const kb = lastKb();
    expect(kb.length).toBe(3);
    expect(kb[0]).toBe(`cnt:set:BTC:15m:1:${candles[200].t}:95`);
    await run(cb(kb[0]));
    const chain = await store.activeChain(db(), 'BTC', '15m');
    expect(chain.map((e) => [e.seq, e.low, e.status])).toEqual([[1, 95, 'confirmed']]);
    expect(await signals()).toHaveLength(0);
    await run(cb('cnt:pick:BTC:15m:3'));
    expect(calls.some((c) => c.method === 'answerCallbackQuery' && String(c.body.text).includes('먼저 2번'))).toBe(true);
    await run(cb(`cnt:set:BTC:15m:2:${candles[220].t}:94`)); // higher-low 위반
    expect(calls.some((c) => c.method === 'answerCallbackQuery' && String(c.body.text).includes('높여가는'))).toBe(true);
    await run(cb(`cnt:set:BTC:15m:2:${candles[220].t}:96`));
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('engine (Durable Object)', () => {
  it('kick sets alarm, poll evaluates watchlist and sends a proposal, webhook self-registers', async () => {
    const stub = env.BOT.get(env.BOT.idFromName('global'));
    let r = (await (await stub.fetch('https://bot/kick', { method: 'POST' })).json()) as { alarm: number };
    expect(r.alarm).toBeGreaterThan(Date.now() - 1000);
    await store.addWatch(db(), 'BTC', ['15m']);
    const l = Array(240).fill(100); l[200] = 89; l[234] = 90; candles = mk(l, Date.now() - 240 * STEP - 1000); // 240봉 전부 마감
    await stub.fetch('https://bot/poll', { method: 'POST' });
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]);
    expect(texts().some((t) => t.includes('1번 저점 후보'))).toBe(true);
    const wh = calls.find((c) => c.method === 'setWebhook');
    expect(String(wh?.body.url)).toBe(`https://bot.test/api/telegram/${await webhookSecret('test-token')}`);
    expect(wh?.body.secret_token).toBe(await webhookHeaderSecret('test-token'));
    r = (await (await stub.fetch('https://bot/status')).json()) as { alarm: number };
    expect(r).toMatchObject({ webhook: { url: expect.stringContaining('/api/telegram/') } });
  });
});

describe('auto-confirm of 2·3 and auto-close on break (grace window)', () => {
  const GRACE = 3 * 60_000;
  async function seedChain(withSignal: boolean) {
    await injectPrices();
    const k = mk(Array(240).fill(60_000)); k[200].l = 59_000;
    const id1 = await store.addCount(db(), 'BTC', '15m', 1, k[200].t, 59_000);
    if (withSignal) await run(cb(`cnt:ok:${id1}`)); // ✅ 1 → 신호 + signal_id 기록
    else await store.setCountStatus(db(), id1, 'confirmed'); // 📍 수동 지정과 같은 상태 (신호 없음)
    const id2 = await store.addCount(db(), 'BTC', '15m', 2, k[220].t, 59_500);
    return { k, id1, id2 };
  }
  it('✅ 1 records the signal id; a proposed 2 older than the grace is confirmed and emits add', async () => {
    const { id1, id2 } = await seedChain(true);
    expect((await store.getCount(db(), id1))?.signalId).toMatch(/^bot-btc-15m-\d+-1$/);
    expect(await processDue(env, Date.now())).toEqual({ confirmed: 0, closed: 0 }); // 아직 유예 안 지남
    expect((await store.getCount(db(), id2))?.status).toBe('proposed');
    calls = [];
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 1, closed: 0 });
    expect((await store.getCount(db(), id2))?.status).toBe('confirmed');
    expect((await store.getCount(db(), id2))?.signalId).toMatch(/-2$/);
    const s = await signals();
    expect(s.map((x) => x.action)).toEqual(['open', 'add']);
    expect(texts().some((t) => t.includes('2번 자동 확정'))).toBe(true);
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 }); // 재실행해도 중복 없음
  });
  it('chain whose 1 was set manually (no signal) or auto off or non-signal tf → not auto-confirmed', async () => {
    const { id2 } = await seedChain(false);
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 });
    expect((await store.getCount(db(), id2))?.status).toBe('proposed');
    await db().batch([db().prepare('DELETE FROM bot_counts'), db().prepare('DELETE FROM auto_signals')]);
    const a = await seedChain(true);
    await store.setBotSetting(db(), 'auto', 'off');
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 });
    await store.setBotSetting(db(), 'auto', 'on'); await store.setBotSetting(db(), 'tfs', '1h');
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 });
    expect((await store.getCount(db(), a.id2))?.status).toBe('proposed');
  });
  it('❌ within the grace prevents auto-confirm', async () => {
    const { id2 } = await seedChain(true);
    await run(cb(`cnt:no:${id2}`));
    expect(await processDue(env, Date.now() + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 });
    expect((await signals()).map((x) => x.action)).toEqual(['open']);
  });
  it('pending break: 무시 keeps; otherwise auto cancel + close at market after the grace', async () => {
    const { id2 } = await seedChain(true);
    await store.setCountStatus(db(), id2, 'confirmed');
    const t = Date.now();
    await store.setPendingBreak(db(), 'BTC', '15m', 2, t, 555);
    await run(cb('cnt:keep:BTC:15m'));
    expect(await processDue(env, t + GRACE + 1000)).toEqual({ confirmed: 0, closed: 0 });
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1, 2]);
    await store.setPendingBreak(db(), 'BTC', '15m', 2, t, 556);
    calls = [];
    expect(await processDue(env, t + GRACE + 1000)).toEqual({ confirmed: 0, closed: 1 });
    expect((await store.activeChain(db(), 'BTC', '15m')).map((e) => e.seq)).toEqual([1]);
    const s = await signals();
    expect(s.at(-1)).toMatchObject({ action: 'close', note: '2번 저점 이탈 → 전량 정리 (15m, 자동)' });
    expect(calls.some((c) => c.method === 'editMessageReplyMarkup' && c.body.message_id === 556)).toBe(true);
    expect(await store.listDueBreaks(db(), t + GRACE * 10)).toEqual([]);
    // 1번 이탈 → 전체 리셋 + 정리
    await store.setPendingBreak(db(), 'BTC', '15m', 1, t, 557);
    expect(await processDue(env, t + GRACE + 1000)).toEqual({ confirmed: 0, closed: 1 });
    expect(await store.activeChain(db(), 'BTC', '15m')).toEqual([]);
  });
});

describe('resultReport formatting', () => {
  const r = { followers: 3, ok: 1, fail: 1, skipped: 1 };
  it('orders 성공 → 실패 → 건너뜀 and numbers them', () => {
    const out = resultReport('📡 BTCUSDT 1번 저점 진입', r, [
      { loginId: 'c', mode: 'paper', status: 'skipped', detail: '쓸 수 있는 돈 없음' },
      { loginId: 'a', mode: 'live', status: 'ok', detail: '오른다 30 USDT 10배 (1계약) · 손절 59000' },
      { loginId: 'b', mode: 'live', status: 'failed', detail: '잔고가 부족해요' },
    ]);
    expect(out).toEqual(['📡 BTCUSDT 1번 저점 진입 → AI 자동매매 3명 → 성공 1 · 실패 1 · 건너뜀 1\n1. a님 ✅ 성공 — 오른다 30 USDT 10배 (1계약) · 손절 59000\n2. b님 ❌ 실패 — 잔고가 부족해요\n3. c님 ⏭ 건너뜀 (연습) — 쓸 수 있는 돈 없음']);
  });
  it('splits long reports into several messages under the Telegram limit', () => {
    const execs = Array.from({ length: 300 }, (_, i) => ({ loginId: `user${String(i).padStart(3, '0')}`, mode: 'live' as const, status: 'ok' as const, detail: '오른다 30 USDT 10배 (1계약) · 손절 59000 · 익절 61000' }));
    const out = resultReport('📡 BTCUSDT 1번 저점 진입', { followers: 300, ok: 300, fail: 0, skipped: 0 }, execs);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(4096);
    expect(out.join('\n').split('\n')).toHaveLength(301);
    expect(out[out.length - 1].endsWith('300. user299님 ✅ 성공 — 오른다 30 USDT 10배 (1계약) · 손절 59000 · 익절 61000')).toBe(true);
  });
  it('dup or no followers → summary only', () => {
    expect(resultReport('h', { followers: 0, ok: 0, fail: 0, skipped: 0 }, [])).toEqual(['h → AI 자동매매 대상 없음 (승인+켬 사용자 0명)']);
    expect(resultReport('h', { followers: 0, ok: 0, fail: 0, skipped: 0, dup: true }, [{ loginId: 'a', mode: 'live', status: 'ok', detail: null }])).toEqual(['h → 이미 실행 중인 신호예요']);
  });
});
