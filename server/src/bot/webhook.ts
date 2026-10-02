// 텔레그램 웹훅 — 관리자 chat 의 명령·버튼을 처리한다 (hlbot handlers/count_handlers 이식, 텍스트 알림판).
import { Hono } from 'hono';
import { SYMBOLS } from '@easy-futures/shared';
import type { AppEnv } from '../auth.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import * as store from './db.js';
import { recentPivots, sendWithChart } from './monitor.js';
import { realDeps } from './deps.js';
import { COIN_SYMBOL, emitBreakeven, emitClose, emitEntry, resultReport } from './signals.js';
import { listSignalExecutions } from '../auto/db.js';
import { SUPPORTED_TFS } from './strategy.js';
import { adminChatId, fmtPx, kst, telegramFor, webhookHeaderSecret, webhookSecret, type InlineKeyboard, type Telegram, type TgUpdate } from './telegram.js';
import { timingSafeEqual } from '../crypto.js';
import { backfillAfter } from './monitor.js';
import { isSkipped, type EmitResult } from './signals.js';

const DEFAULT_TFS = ['15m', '1h', '4h'];
const COIN_RE = /^[A-Z0-9]{2,12}$/;

export const telegramRoutes = new Hono<AppEnv>();
telegramRoutes.post('/:secret', async (c) => {
  const tg = telegramFor(c.env);
  if (!tg || !c.env.TELEGRAM_BOT_TOKEN) return c.json({ ok: false }, 503);
  const [pathSecret, headerSecret] = await Promise.all([webhookSecret(c.env.TELEGRAM_BOT_TOKEN), webhookHeaderSecret(c.env.TELEGRAM_BOT_TOKEN)]);
  const givenPath = c.req.param('secret') ?? ''; const givenHeader = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (givenPath.length !== pathSecret.length || !timingSafeEqual(givenPath, pathSecret) || givenHeader.length !== headerSecret.length || !timingSafeEqual(givenHeader, headerSecret)) return c.json({ ok: false }, 401);
  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  if (!update) return c.json({ ok: true });
  // 텔레그램은 응답이 늦으면 같은 update 를 다시 보낸다 — 두 번 처리하면 정리/본절 신호가 두 번 나간다
  if (typeof update.update_id === 'number' && !(await store.claimUpdate(c.env.DB, update.update_id))) return c.json({ ok: true, dup: true });
  await handleUpdate(c.env, tg, update, (p) => c.executionCtx.waitUntil(p)).catch((e) => log.error('telegram update failed', e));
  return c.json({ ok: true });
});

export type Defer = (p: Promise<unknown>) => void;

export async function handleUpdate(env: Env, tg: Telegram, update: TgUpdate, defer: Defer): Promise<void> {
  const admin = adminChatId(env);
  if (update.message?.text) {
    const chat = update.message.chat.id;
    const text = update.message.text.trim();
    // chat 뿐 아니라 보낸 사람(from)도 관리자여야 한다 — 그룹 chat 이 등록돼도 다른 멤버가 조작하지 못하게
    const sender = update.message.from?.id ?? chat;
    if (admin === null || chat !== admin || sender !== admin) {
      if (text.startsWith('/start')) await tg.sendMessage(chat, `chat_id: ${chat}\n${admin === null ? '관리자 chat 이 아직 등록되지 않았어요. 이 값을 TELEGRAM_ADMIN_CHAT_ID 시크릿으로 넣어 주세요.' : '이 봇은 관리자만 쓸 수 있어요.'}`);
      return;
    }
    await handleCommand(env, tg, chat, text, defer);
    return;
  }
  const q = update.callback_query;
  if (q?.data && q.message) {
    const sender = q.from?.id ?? q.message.chat.id;
    if (admin === null || q.message.chat.id !== admin || sender !== admin) { await tg.answerCallback(q.id, '관리자만 쓸 수 있어요'); return; }
    await handleCallback(env, tg, q as Query, defer);
  }
}

// ---------- 명령 ----------
async function handleCommand(env: Env, tg: Telegram, chat: number, text: string, defer: Defer): Promise<void> {
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@\w+$/, '').toLowerCase();
  const say = (t: string, kb?: InlineKeyboard) => tg.sendMessage(chat, t, kb);
  const db = env.DB;
  switch (cmd) {
    case '/start':
      return void (await say(`Easy futures 저점 봇 준비 완료 ✅\nchat_id: ${chat}\n/watch BTC — 감시 등록 · /status — 현황 · /count BTC 15m — 카운트 관리\n/bot — AI 자동매매 연결 설정 · /panic — 비상 정리`));
    case '/watch': {
      const coin = (args[0] ?? '').toUpperCase();
      if (!COIN_RE.test(coin)) return void (await say('사용법: /watch BTC [15m 1h 4h]'));
      const tfs = args.slice(1).length ? args.slice(1) : DEFAULT_TFS;
      const bad = tfs.filter((t) => !SUPPORTED_TFS.includes(t));
      if (bad.length) return void (await say(`지원하지 않는 타임프레임: ${bad.join(' ')} (가능: ${SUPPORTED_TFS.join(' ')})`));
      await store.addWatch(db, coin, tfs);
      await env.BOT.get(env.BOT.idFromName('global')).fetch('https://bot/kick', { method: 'POST' }).catch(() => null);
      const note = COIN_SYMBOL[coin] ? '' : '\n(이 코인은 Easy futures 미지원 — 알림만 오고 AI 자동매매 신호는 안 나가요)';
      return void (await say(`👀 ${coin} 감시 시작: ${tfs.join(' ')}${note}`));
    }
    case '/unwatch': {
      const coin = (args[0] ?? '').toUpperCase();
      if (!COIN_RE.test(coin)) return void (await say('사용법: /unwatch BTC'));
      const n = await store.removeWatch(db, coin);
      return void (await say(n ? `🙈 ${coin} 감시 해제 (${n}개 TF)` : `${coin} 은 감시 중이 아니에요`));
    }
    case '/status': return void (await say(await statusText(env)));
    case '/signal': case '/chart': {
      const coin = (args[0] ?? '').toUpperCase(); const tf = args[1] ?? '15m';
      if (!COIN_RE.test(coin) || !SUPPORTED_TFS.includes(tf)) return void (await say('사용법: /signal ETH [15m]'));
      const chain = await store.activeChain(db, coin, tf);
      const deps = realDeps(env);
      const seqs = chain.length ? chain.map((e) => `${e.seq}${e.status === 'confirmed' ? '✅' : '⏳'}`).join(' → ') : '없음';
      try { await sendWithChart(deps, coin, tf, [], chain.map((e) => ({ tsMs: e.tsMs, label: String(e.seq) })), `📈 ${coin} · ${tf}\n🔢 카운트: ${seqs}`, null); }
      catch (e) { await say(`⚠️ 차트를 만들지 못했어요: ${(e as Error).message}`); }
      return;
    }
    case '/count': {
      const coin = (args[0] ?? '').toUpperCase(); const tf = args[1] ?? '15m';
      if (!COIN_RE.test(coin) || !SUPPORTED_TFS.includes(tf)) return void (await say('사용법: /count BTC 15m'));
      const v = await countView(db, coin, tf);
      return void (await say(v.text, v.keyboard));
    }
    case '/bot': return void (await say(await botSettingsCommand(db, args)));
    case '/close': case '/be': {
      const coin = (args[0] ?? '').toUpperCase();
      if (!COIN_SYMBOL[coin]) return void (await say(`사용법: ${cmd} BTC (지원: ${Object.keys(COIN_SYMBOL).join(', ')})`));
      const em = cmd === '/close' ? await emitClose(env, coin, `수동 정리 (${cmd})`) : await emitBreakeven(env, coin, `수동 본절 (${cmd})`);
      return void (await report(db, tg, chat, em, defer));
    }
    case '/panic':
      return void (await say(`⚠️ ${Object.keys(COIN_SYMBOL).join('·')} AI 자동매매 사용자 전원의 포지션을 전량 정리합니다. 진행할까요?`, [[{ text: '🔴 실행', callback_data: 'bot:panic_yes' }, { text: '취소', callback_data: 'cnt:ignore:-' }]]));
    default:
      return void (await say('모르는 명령이에요. /start 로 목록을 보세요'));
  }
}

async function botSettingsCommand(db: D1Database, args: string[]): Promise<string> {
  const s = await store.getBotSettings(db);
  const sub = (args[0] ?? '').toLowerCase();
  const set = async (key: 'relay' | 'leverage' | 'tpR' | 'tfs' | 'auto' | 'grace', value: string) => { await store.setBotSetting(db, key, value, 'telegram'); log.info('bot setting', { key, value, by: 'telegram' }); };
  if (sub === 'on' || sub === 'off') { await set('relay', sub); s.relay = sub === 'on'; }
  else if (sub === 'auto') { const v = (args[1] ?? '').toLowerCase(); if (v !== 'on' && v !== 'off') return '예: /bot auto on|off (2·3번 후보와 이탈을 유예 뒤 자동 처리)'; await set('auto', v); s.autoConfirm = v === 'on'; }
  else if (sub === 'grace') { const n = Number(args[1]); if (!(Number.isInteger(n) && n >= 1 && n <= 30)) return '유예는 1~30분 정수 (예: /bot grace 3)'; await set('grace', String(n)); s.graceMin = n; }
  else if (sub === 'lev') { const n = Number(args[1]); if (!(Number.isInteger(n) && n >= 1 && n <= 50)) return '배율은 1~50 정수 (예: /bot lev 3)'; await set('leverage', String(n)); s.leverage = n; }
  else if (sub === 'tpr') { const n = Number(args[1]); if (!(Number.isFinite(n) && n >= 0 && n <= 10)) return '익절 R배수는 0~10 (0 = 익절 없음, 예: /bot tpr 1.5)'; await set('tpR', String(n)); s.tpR = n; }
  else if (sub === 'tfs') { const tfs = [...new Set(args.slice(1))]; if (tfs.length === 1 && tfs[0] === 'all') { await set('tfs', ''); s.tfs = []; } else { const bad = tfs.filter((t) => !SUPPORTED_TFS.includes(t)); if (!tfs.length || bad.length) return '예: /bot tfs 15m 1h · 전체는 /bot tfs all'; await set('tfs', tfs.join(' ')); s.tfs = tfs; } }
  else if (sub) return '사용법: /bot · /bot on|off · /bot lev 3 · /bot tpr 1.5 · /bot tfs 15m 1h · /bot auto on|off · /bot grace 3';
  return `🤖 AI 자동매매 연결: ${s.relay ? '켜짐 ✅' : '꺼짐 ⛔'}\n종목 ${Object.values(COIN_SYMBOL).join(', ')} · 배율 ${s.leverage}배 · 익절 ${s.tpR}R · TF ${s.tfs.length ? s.tfs.join(' ') : '전체'}\n자동 처리: ${s.autoConfirm ? `켜짐 (2·3번 후보·이탈은 ${s.graceMin}분 유예 뒤 자동)` : '꺼짐 (전부 버튼으로)'} — 1번은 항상 사람이 ✅\n✅ N 맞아 → 진입/불타기 · 🗑 취소/리셋 → 전량 정리 · 🔁 새 사이클 → 본절\n/bot on|off · /bot lev 3 · /bot tpr 1.5 · /bot tfs 15m 1h · /bot auto on|off · /bot grace 3`;
}

export async function statusText(env: Env): Promise<string> {
  const [watches, chains, states, s] = await Promise.all([store.listWatches(env.DB), store.listActiveChains(env.DB), store.listWatchState(env.DB), store.getBotSettings(env.DB)]);
  const lines = ['👀 감시목록'];
  const keys = Object.keys(watches);
  if (!keys.length) lines.push('없음 — /watch BTC 로 시작');
  for (const coin of keys) for (const tf of watches[coin]) {
    const ch = chains[`${coin}:${tf}`] ?? [];
    const st = states.find((x) => x.coin === coin && x.tf === tf);
    const seqs = ch.length ? ch.map((e) => `${e.seq}${e.status === 'confirmed' ? '✅' : '⏳'}`).join(' → ') : '카운트 없음';
    const when = st?.lastPollAt ? `${kst(st.lastPollAt)} 평가` : '아직 평가 전';
    lines.push(`• ${coin} · ${tf}: ${seqs} (${when}${st?.lastError ? ` · ⚠️ ${st.lastError}` : ''})`);
  }
  lines.push(`🤖 AI 자동매매 연결 ${s.relay ? '켜짐' : '꺼짐'} · ${s.leverage}배 · 익절 ${s.tpR}R · 2·3번 자동 ${s.autoConfirm ? `${s.graceMin}분 유예` : '꺼짐'}`);
  return lines.join('\n');
}

async function countView(db: D1Database, coin: string, tf: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const chain = await store.activeChain(db, coin, tf);
  const have = new Set(chain.map((e) => e.seq));
  const pickRow: InlineKeyboard[number] = [1, ...[2, 3].filter((s) => have.has(s - 1))].map((s) => ({ text: `📍 ${s} 지정`, callback_data: `cnt:pick:${coin}:${tf}:${s}` }));
  if (!chain.length) return { text: `${coin} · ${tf} — 활성 카운트 없음`, keyboard: [pickRow] };
  const lines = [`🔢 ${coin} · ${tf} — 현재 카운트`, ...chain.map((e) => `${e.seq}️⃣ ${kst(e.tsMs)} (${fmtPx(e.low)}) ${e.status === 'confirmed' ? '✅' : '잠정'}`)];
  const row: InlineKeyboard[number] = chain.filter((e) => e.seq >= 2).map((e) => ({ text: e.seq === chain[chain.length - 1].seq ? `${e.seq}만 취소` : `${e.seq}부터 취소`, callback_data: `cnt:cancel:${coin}:${tf}:${e.seq}` }));
  row.push({ text: '전체 리셋', callback_data: `cnt:reset:${coin}:${tf}` });
  return { text: lines.join('\n'), keyboard: [row, pickRow] };
}

// ---------- 버튼 ----------
type Query = { id: string; data: string; from?: { id: number }; message: { message_id: number; chat: { id: number }; text?: string; caption?: string } };

async function handleCallback(env: Env, tg: Telegram, q: Query, defer: Defer): Promise<void> {
  const db = env.DB;
  const chat = q.message.chat.id;
  const parts = q.data.split(':');
  // 처리 완료 표시: 사진 메시지는 캡션을, 글 메시지는 본문을 편집 (둘 다 버튼이 사라진다). 편집이 거부돼도 버튼은 반드시 지운다 —
  // 버튼이 남으면 며칠 뒤 오터치 한 번에 전원 정리 신호가 나간다 (감사 전략 H1)
  const done = async (note: string) => {
    if (q.message.caption != null) await tg.editCaption(chat, q.message.message_id, `${q.message.caption}\n→ ${note}`);
    else if (q.message.text != null) await tg.editText(chat, q.message.message_id, `${q.message.text}\n→ ${note}`);
    await tg.clearKeyboard(chat, q.message.message_id);
  };
  const [ns, action] = parts;
  const validPair = (coin: string, tf: string) => COIN_RE.test(coin) && SUPPORTED_TFS.includes(tf);

  if (ns === 'bot' && action === 'panic_yes') {
    await tg.answerCallback(q.id);
    await done('🔴 실행');
    for (const coin of Object.keys(COIN_SYMBOL)) await report(db, tg, chat, await emitClose(env, coin, '비상 정리 (/panic)'), defer);
    return;
  }
  if (ns !== 'cnt') { await tg.answerCallback(q.id); return; }

  if (action === 'ignore') { await tg.answerCallback(q.id, '무시했어요'); await done('무시함'); return; }
  if (action === 'keep') {
    const [coin, tf] = [parts[2], parts[3]];
    if (!validPair(coin, tf)) { await tg.answerCallback(q.id, '잘못된 값'); return; }
    const was = await store.clearPendingBreak(db, coin, tf);
    await tg.answerCallback(q.id, was ? '유지할게요' : '이미 처리됐어요');
    await done(was ? '무시함 — 카운트·포지션 유지 (자동 정리 취소)' : '이미 처리된 알림이에요');
    return;
  }

  if (action === 'ok' || action === 'no') {
    const id = Number(parts[2]);
    const row = await store.getCount(db, id);
    // ❌ 는 잠정(proposed) 상태에서만 — 이미 ✅ 로 확정된 카운트를 ❌ 로 지우면 사용자 포지션은 남은 채 체인만 사라진다. 확정 뒤 취소는 /count 의 취소·리셋으로
    if (!row || (action === 'no' && row.status !== 'proposed')) { await tg.answerCallback(q.id, row?.status === 'confirmed' ? '이미 ✅ 확정된 카운트예요 — 취소는 /count 에서' : '이미 처리된 카운트예요'); return; }
    if (!(await store.setCountStatus(db, id, action === 'ok' ? 'confirmed' : 'vetoed'))) { await tg.answerCallback(q.id, '이미 처리된 카운트예요'); return; }
    await tg.answerCallback(q.id);
    if (action === 'no') { await store.cancelFrom(db, row.coin, row.tf, row.seq + 1); await done('❌ 무효 — 다음 후보 대기'); return; }
    await done(`✅ ${row.seq} 확정${row.seq === 3 ? ' · 🚀 3의 법칙 완성!' : ''}`);
    const em = await emitEntry(env, row.coin, row.tf, row.seq, row.tsMs, row.low);
    if (!isSkipped(em)) await store.setCountSignal(db, id, em.signal.id); // 신호가 실제 나간 체인만 2·3번 자동 확정 대상
    await report(db, tg, chat, em, defer);
    return;
  }
  if (action === 'cancel') {
    const [coin, tf, seq] = [parts[2], parts[3], Number(parts[4])];
    if (!validPair(coin, tf)) { await tg.answerCallback(q.id, '잘못된 값'); return; }
    const r = await store.cancelFrom(db, coin, tf, seq);
    await store.clearPendingBreak(db, coin, tf);
    await tg.answerCallback(q.id, `${r.n}개 카운트 취소`);
    if (r.n === 0) { await done(`이미 취소된 카운트예요 (${coin} · ${tf}) — 신호는 보내지 않았어요`); return; } // 오래된 버튼 재탭 보호
    if (r.confirmed === 0) { await done(`🗑 ${coin} · ${tf} — ${seq}번부터 취소 (잠정 후보 ${r.n}개) — 확정 저점이 아니라 신호는 없어요`); return; }
    await done(`🗑 ${coin} · ${tf} — ${seq}번부터 취소 완료 (${r.n}개) → 전량 정리`);
    await report(db, tg, chat, await emitClose(env, coin, `${seq}번 저점 이탈 → 전량 정리 (${tf})`, `${tf}-c${seq}-${q.message.message_id}`), defer); // 같은 /count 메시지에서 취소·리셋이 이어져도 id 가 겹치지 않게
    return;
  }
  if (action === 'reset') {
    const [coin, tf] = [parts[2], parts[3]];
    if (!validPair(coin, tf)) { await tg.answerCallback(q.id, '잘못된 값'); return; }
    const r = await store.cancelFrom(db, coin, tf, 1);
    await store.setBreakMs(db, coin, tf, 0);
    await store.clearPendingBreak(db, coin, tf);
    await tg.answerCallback(q.id, `전체 리셋 (${r.n}개 취소)`);
    if (r.n === 0) { await done(`활성 카운트가 없어요 (${coin} · ${tf}) — 신호는 보내지 않았어요`); return; } // 오래된 버튼 재탭 보호
    if (r.confirmed === 0) { await done(`🗑 ${coin} · ${tf} — 리셋 (잠정 후보 ${r.n}개만) — 확정 저점이 아니라 신호는 없어요 · 새 1 탐색 중`); return; }
    await done(`🗑 ${coin} · ${tf} — 카운트 리셋 완료 (${r.n}개 취소) · 새 1(바닥 리테스트) 탐색 중`);
    // 새 사이클 리셋(:nc)은 저점이 깨진 게 아니라 본절로만, 1번 이탈·바닥 갱신 리셋은 전량 정리
    const key = `${tf}-reset-${q.message.message_id}`;
    const em = parts[4] === 'nc' ? await emitBreakeven(env, coin, `새 사이클 리셋 → 본절 (${tf})`, key) : await emitClose(env, coin, `1번 저점 이탈 → 전량 정리 (${tf})`, key);
    await report(db, tg, chat, em, defer);
    return;
  }
  if (action === 'show') { if (!validPair(parts[2], parts[3])) { await tg.answerCallback(q.id, '잘못된 값'); return; } await tg.answerCallback(q.id); const v = await countView(db, parts[2], parts[3]); await tg.sendMessage(chat, v.text, v.keyboard); return; }
  if (action === 'pick') {
    const [coin, tf] = [parts[2], parts[3]]; const seq = Number(parts[4] ?? 1);
    if (!validPair(coin, tf)) { await tg.answerCallback(q.id, '잘못된 값'); return; }
    const chain = await store.activeChain(db, coin, tf);
    const prev = seq > 1 ? chain.find((e) => e.seq === seq - 1) : null;
    if (seq > 1 && !prev) { await tg.answerCallback(q.id, `먼저 ${seq - 1}번을 지정하세요`); return; }
    await tg.answerCallback(q.id);
    let pivots: { tsMs: number; low: number }[] = [];
    try { pivots = await recentPivots(coin, tf, realDeps(env), prev?.tsMs ?? 0); }
    catch (e) { await tg.sendMessage(chat, `⚠️ 캔들 조회 실패: ${(e as Error).message}`); return; }
    if (!pivots.length) { await tg.sendMessage(chat, `${coin} · ${tf} — 최근 저점 후보가 없어요`); return; }
    const lines = [`📍 ${coin} · ${tf} — ${seq}번으로 지정할 저점 선택`];
    const kb: InlineKeyboard = pivots.map((p, i) => { lines.push(`${i + 1}. ${kst(p.tsMs)} (${fmtPx(p.low)})`); return [{ text: `${i + 1}. ${kst(p.tsMs)} (${fmtPx(p.low)})`, callback_data: `cnt:set:${coin}:${tf}:${seq}:${p.tsMs}:${p.low}` }]; });
    await tg.sendMessage(chat, lines.join('\n'), kb);
    return;
  }
  if (action === 'set') {
    const [coin, tf] = [parts[2], parts[3]]; const seq = Number(parts[4]); const tsMs = Number(parts[5]); const low = Number(parts[6]);
    if (!validPair(coin, tf) || !(seq >= 1 && seq <= 3) || !(tsMs > 0) || !(low > 0)) { await tg.answerCallback(q.id, '잘못된 값'); return; }
    if (seq > 1) {
      const prev = (await store.activeChain(db, coin, tf)).find((e) => e.seq === seq - 1);
      if (!prev) { await tg.answerCallback(q.id, `먼저 ${seq - 1}번을 지정하세요`); return; }
      if (tsMs <= prev.tsMs) { await tg.answerCallback(q.id, `${seq}번은 ${seq - 1}번보다 뒤여야 해요`); return; }
      if (low <= prev.low) { await tg.answerCallback(q.id, `${seq}번 저가가 ${seq - 1}번 이하 — 저점을 높여가는 구조가 아니에요`); return; }
    }
    await store.setManual(db, coin, tf, seq, tsMs, low);
    await store.setBreakMs(db, coin, tf, 0);
    await tg.answerCallback(q.id);
    await done(`📍 ${seq} 지정 완료 (${kst(tsMs)} · ${fmtPx(low)}) — 수동 지정은 AI 자동매매 신호를 보내지 않아요`);
    // 소급 스캔: 지정한 봉 이후에 이미 생긴 다음 저점 후보를 제안 (hlbot _backfill_counts)
    try { const sent = await backfillAfter(db, coin, tf, tsMs, realDeps(env)); await tg.sendMessage(chat, sent ? `🔎 소급 스캔: ${sent}개 후보를 제안했어요 — ✅/❌로 판정해주세요` : '🔎 소급 스캔: 추가 후보 없음'); }
    catch (e) { await tg.sendMessage(chat, `⚠️ 소급 스캔 실패: ${(e as Error).message}`); }
    return;
  }
  await tg.answerCallback(q.id);
}

/** 신호 결과를 텔레그램에 보고. 실행은 뒤로 미뤄(defer) 웹훅 응답을 막지 않는다 */
export async function report(db: D1Database, tg: Telegram, chat: number, em: EmitResult | null, defer: Defer): Promise<void> {
  if (!em) return;
  if (isSkipped(em)) { await tg.sendMessage(chat, `ℹ️ ${em.skipped}`, null, true); return; }
  await tg.sendMessage(chat, `📡 AI 자동매매 신호 — ${em.summary}\n실행 중…`, null, true);
  const head = `📡 ${em.signal.symbol} ${em.signal.note ?? em.signal.action}`;
  defer(em.run().then(async (r) => {
    // 사용자별 결과: 실행 기록(auto_executions)을 읽어 "N. 아이디님 성공/실패/건너뜀 — 사유" 로 보인다
    const execs = await listSignalExecutions(db, em.signal.id).catch(() => []);
    for (const text of resultReport(head, r, execs)) await tg.sendMessage(chat, text, null, true);
  }).catch((e) => tg.sendMessage(chat, `⚠️ 신호 실행 오류: ${(e as Error).message}`)));
}
/** 유예가 지난 잠정 2·3번 후보를 자동 확정(불타기 신호)하고, 이탈 알림에 응답이 없으면 자동 취소·전량 정리.
 *  BottomWatcher 틱(60초)마다 호출. 대상은 autoEligible 체인(설정 켜짐 + 신호 TF + 1번이 ✅ 로 신호가 나간 체인)뿐 */
export async function processDue(env: Env, now = Date.now()): Promise<{ confirmed: number; closed: number }> {
  const tg = telegramFor(env); const chat = adminChatId(env);
  const out = { confirmed: 0, closed: 0 };
  if (!tg || chat === null) return out;
  const db = env.DB;
  const s = await store.getBotSettings(db);
  if (!s.autoConfirm) return out;
  const cutoff = now - s.graceMin * 60_000;
  const tasks: Promise<unknown>[] = []; const defer: Defer = (p) => tasks.push(p);
  for (const row of await store.listDueProposals(db, cutoff)) {
    const chain = await store.activeChain(db, row.coin, row.tf);
    if (!store.autoEligible(s, row.tf, chain)) continue;
    const prev = chain.find((e) => e.seq === row.seq - 1);
    if (!prev || prev.status !== 'confirmed') continue; // 앞 번호가 아직 잠정이면 순서를 기다린다
    if (!(await store.setCountStatus(db, row.id, 'confirmed'))) continue; // 그 사이 사람이 눌렀으면 건너뜀
    log.info('bot auto-confirm', { coin: row.coin, tf: row.tf, seq: row.seq, id: row.id });
    if (row.msgId) await tg.clearKeyboard(chat, row.msgId);
    await tg.sendMessage(chat, `⏱ ${row.coin} · ${row.tf} — ${row.seq}번 자동 확정 (${s.graceMin}분 동안 ❌ 없음 · ${kst(row.tsMs)} · ${fmtPx(row.low)})${row.seq === 3 ? ' · 🚀 3의 법칙 완성!' : ''}`);
    const em = await emitEntry(env, row.coin, row.tf, row.seq, row.tsMs, row.low);
    if (!isSkipped(em)) await store.setCountSignal(db, row.id, em.signal.id);
    await report(db, tg, chat, em, defer);
    out.confirmed++;
  }
  for (const b of await store.listDueBreaks(db, cutoff)) {
    if (!(await store.clearPendingBreak(db, b.coin, b.tf))) continue;
    const chain = await store.activeChain(db, b.coin, b.tf);
    if (!store.autoEligible(s, b.tf, chain)) continue; // 그 사이 체인이 바뀌었으면(리셋·수동 지정) 대기만 지운다
    const r = await store.cancelFrom(db, b.coin, b.tf, b.seq);
    if (b.seq === 1) await store.setBreakMs(db, b.coin, b.tf, 0);
    if (b.msgId) await tg.clearKeyboard(chat, b.msgId);
    if (r.n === 0) continue;
    log.info('bot auto-cancel', { coin: b.coin, tf: b.tf, seq: b.seq, cancelled: r.n, confirmed: r.confirmed });
    if (r.confirmed === 0) { await tg.sendMessage(chat, `⏱ ${b.coin} · ${b.tf} — ${b.seq}번 이탈 자동 취소 (잠정 후보 ${r.n}개) — 확정 저점이 아니라 신호는 없어요`); continue; }
    await tg.sendMessage(chat, `⏱ ${b.coin} · ${b.tf} — ${b.seq}번 저점 이탈, ${s.graceMin}분 동안 '무시' 없음 → ${b.seq === 1 ? '전체 리셋' : `${b.seq}번부터 취소`} · 전량 정리`);
    await report(db, tg, chat, await emitClose(env, b.coin, `${b.seq}번 저점 이탈 → 전량 정리 (${b.tf}, 자동)`, `${b.tf}-auto-${b.at}`), defer);
    out.closed++;
  }
  await Promise.all(tasks);
  return out;
}
export { SYMBOLS };
