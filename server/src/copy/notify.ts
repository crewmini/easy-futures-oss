// 카피 트레이딩 운영 알림 — 관리자 텔레그램(TELEGRAM_ADMIN_CHAT_ID)으로 한 줄. 절대 던지지 않고, 미설정이면 조용히 아무것도 안 한다.
// 같은 key 는 10분에 한 번만 (copy_flags 의 `notify:<key>` 행에 마지막 발송 시각). 호출자는 `void notifyX(...)` 로 붙이고 기다리지 않는다.
import type { CopyEvent, CopyLeftoverReason, Direction, Symbol } from '@easy-futures/shared';
import { adminChatId, telegramFor } from '../bot/telegram.js';
import { findUserById } from '../db.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { getCopyFlag, getMaster, listEventExecutions, setCopyFlag } from './db.js';

export const NOTIFY_DEDUPE_MS = 10 * 60_000;
const MAX_LEN = 600;
const PREFIX = '[카피] ';

type NotifyEnv = Pick<Env, 'DB' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_ADMIN_CHAT_ID' | 'TELEGRAM_API_BASE'>;
export interface NotifyOpts { key?: string; dedupeMs?: number }

/** 텔레그램 전송 지점 — 테스트에서 바꿔 끼운다 (bot/net.ts 의 fetch 를 바꿔도 된다) */
export const notifyDeps = {
  send: async (env: NotifyEnv, chatId: number, text: string): Promise<void> => { await telegramFor(env)!.sendMessage(chatId, text, null, false); },
};

/** 아이디 마스킹 (routes/copy.ts maskLoginId 와 같은 규칙 — 순환 import 를 피해 복제) */
const mask = (loginId: string): string => (loginId.length <= 4 ? loginId.slice(0, 1) + '***' : loginId.slice(0, 2) + '***' + loginId.slice(-1));
const dirLabel = (d: Direction) => (d === 'long' ? '오른다' : '내린다');
const num = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toLocaleString('en-US', { maximumSignificantDigits: 5 }));
const pnl = (v: number) => `${v >= 0 ? '+' : ''}${num(Math.round(v * 100) / 100)}`;

async function masked(env: NotifyEnv, userId: number): Promise<string> {
  const u = await findUserById(env.DB, userId).catch(() => null);
  return u ? mask(u.login_id) : `#${userId}`;
}
async function masterName(env: NotifyEnv, masterId: number): Promise<string> {
  const m = await getMaster(env.DB, masterId).catch(() => null);
  return m?.nickname ?? `고수#${masterId}`;
}

/**
 * 관리자에게 한 줄. key 가 있으면 10분 안에 같은 key 는 보내지 않는다. 보냈으면 true, 미설정·중복·실패면 false. 절대 던지지 않는다
 */
export async function notifyAdmin(env: NotifyEnv, text: string, opts: NotifyOpts = {}): Promise<boolean> {
  try {
    const chat = adminChatId(env);
    if (!telegramFor(env) || !chat) return false;
    const dedupeMs = opts.dedupeMs ?? NOTIFY_DEDUPE_MS;
    if (opts.key) {
      const flagKey = `notify:${opts.key}`.slice(0, 200);
      const last = Number(await getCopyFlag(env.DB, flagKey));
      if (Number.isFinite(last) && last > 0 && Date.now() - last < dedupeMs) return false;
      await setCopyFlag(env.DB, flagKey, String(Date.now()), 'notify');
    }
    const body = (PREFIX + text.replace(/\s+\n/g, '\n').trim()).slice(0, MAX_LEN);
    await notifyDeps.send(env, chat, body);
    return true;
  } catch (e) {
    log.warn('copy admin notify failed', { message: (e as Error).message, key: opts.key });
    return false;
  }
}

// ---------- 트리거별 문장 (호출자는 void 로 붙인다) ----------
type Result = { symbol: Symbol; status: string; detail: string | null };
const resultLine = (r: Result) => `${r.symbol} ${r.status === 'ok' ? '정리' : r.status === 'skipped' ? '건너뜀' : '실패'}${r.detail ? ` (${r.detail.slice(0, 60)})` : ''}`;

/** 손실 한도 도달 → 멈추고 전량 정리 (stopped) */
export async function notifyLossLimit(env: NotifyEnv, follow: { id: number; followerId: number; masterId: number; realizedPnl: number; settings: { copyAmount: number; lossLimitPct: number } }, results: Result[]): Promise<boolean> {
  const [who, master] = await Promise.all([masked(env, follow.followerId), masterName(env, follow.masterId)]);
  return notifyAdmin(env, `손실 한도 도달 — 팔로워 ${who} (고수 ${master}) 멈추고 전량 정리\n실현손익 ${pnl(follow.realizedPnl)} / 따라갈 돈 ${num(follow.settings.copyAmount)} USDT (한도 ${follow.settings.lossLimitPct}%)\n${results.map(resultLine).join('; ') || '장부 없음'}`, { key: `loss:${follow.id}` });
}
/** 손실 한도 정리 일부 실패 → 팔로우는 유지, 다음 점검에서 재시도 */
export async function notifyLossLimitPartial(env: NotifyEnv, follow: { id: number; followerId: number; masterId: number }, results: Result[]): Promise<boolean> {
  const [who, master] = await Promise.all([masked(env, follow.followerId), masterName(env, follow.masterId)]);
  const bad = results.filter((r) => r.status !== 'ok');
  return notifyAdmin(env, `손실 한도 정리 일부 실패 — 팔로워 ${who} (고수 ${master}). 다음 점검(15초)에서 재시도\n${bad.map(resultLine).join('; ')}`, { key: `loss-partial:${follow.id}` });
}
/** 놓친 정리 보정(15초 점검이 시장가로 정리) */
export async function notifySwept(env: NotifyEnv, follow: { id: number; followerId: number; masterId: number }, results: Result[]): Promise<boolean> {
  const [who, master] = await Promise.all([masked(env, follow.followerId), masterName(env, follow.masterId)]);
  return notifyAdmin(env, `놓친 정리 보정 — 팔로워 ${who} (고수 ${master}): 고수는 이미 정리했는데 장부가 남아 시장가로 정리\n${results.map(resultLine).join('; ')}`, { key: `swept:${follow.id}:${results.map((r) => r.symbol).join(',')}` });
}
/** 팬아웃에 실패가 있는 이벤트 — 팔로워별 사유 한 줄씩 (아이디 마스킹). 이벤트당 1회 */
export async function notifyEventFailures(env: NotifyEnv, ev: Pick<CopyEvent, 'id' | 'kind' | 'symbol' | 'direction' | 'masterId'>, fail: number, total: number): Promise<boolean> {
  const [rows, master] = await Promise.all([listEventExecutions(env.DB, ev.id).catch(() => []), masterName(env, ev.masterId)]);
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'pending');
  const lines = failed.slice(0, 8).map((r) => `${mask(r.loginId)}: ${(r.detail ?? (r.status === 'pending' ? '결과 미확인' : '실패')).slice(0, 70)}`);
  if (failed.length > 8) lines.push(`… 외 ${failed.length - 8}명`);
  return notifyAdmin(env, `${ev.kind} ${ev.symbol} ${dirLabel(ev.direction)} (고수 ${master}) 실패 ${fail}/${total}\n${ev.id}\n${lines.join('\n')}`, { key: `event-fail:${ev.id}` });
}
/** 고수 감시 폴링 연속 실패 (5회째) */
export async function notifyMasterPollFailures(env: NotifyEnv, masterId: number, failures: number, message: string): Promise<boolean> {
  const master = await masterName(env, masterId);
  return notifyAdmin(env, `고수 ${master} 감시 ${failures}회 연속 실패 — ${message.slice(0, 160)}\n(팔로워 신호가 멈춰 있을 수 있음. 관리자 카드에서 감시 상태 확인)`, { key: `poll-fail:${masterId}` });
}
/** 고수 강제정리·ADL 로 정리됨 */
export async function notifyMasterLiquidated(env: NotifyEnv, masterId: number, symbol: Symbol, reason: 'liquidation' | 'adl', eventId: string): Promise<boolean> {
  const master = await masterName(env, masterId);
  return notifyAdmin(env, `고수 ${master} ${symbol} ${reason === 'liquidation' ? '강제정리(liquidation)' : '자동감축(ADL)'} — 팔로워 정리 이벤트 ${eventId}. 팔로워 손실 한도·남은 포지션 확인`, { key: `liq:${masterId}:${symbol}` });
}
/** 주문은 나갔는데 결과를 모름(pending 으로 남김) */
export async function notifyUnconfirmed(env: NotifyEnv, ev: Pick<CopyEvent, 'id' | 'kind' | 'symbol' | 'masterId'>, followerId: number, orderId: string | null): Promise<boolean> {
  const who = await masked(env, followerId);
  return notifyAdmin(env, `주문 접수 후 확인 실패 — 팔로워 ${who} ${ev.kind} ${ev.symbol} (${ev.id})${orderId ? ` 주문 ${orderId}` : ''}. 60초 복구가 거래소 조회로 장부에 올리거나 2분 뒤 결과 불명으로 닫음`, { key: `unconfirmed:${ev.id}:${followerId}` });
}
/** pending/실패 행을 거래소 조회로 되찾아 장부에 올림 */
export async function notifyRecovered(env: NotifyEnv, ev: Pick<CopyEvent, 'id' | 'kind' | 'symbol' | 'masterId'>, followerId: number, qty: number, note: string): Promise<boolean> {
  const who = await masked(env, followerId);
  return notifyAdmin(env, `미확인 주문 복구 — 팔로워 ${who} ${ev.kind} ${ev.symbol} (${ev.id}) ${qty}계약을 거래소 주문 조회로 장부에 올림${note ? note.slice(0, 120) : ''}`, { key: `recovered:${ev.id}:${followerId}` });
}
/** 따라하기가 멈추며 정리하지 못한 포지션이 남음 (팔로워 화면에도 뜬다) */
export async function notifyLeftovers(env: NotifyEnv, follow: { id: number; followerId: number; masterId: number }, reason: CopyLeftoverReason, rows: { symbol: Symbol; direction: Direction; contracts: number }[]): Promise<boolean> {
  if (rows.length === 0) return false;
  const [who, master] = await Promise.all([masked(env, follow.followerId), masterName(env, follow.masterId)]);
  return notifyAdmin(env, `따라하기 멈춤(${reason}) — 팔로워 ${who} (고수 ${master}) 정리하지 못한 포지션 ${rows.length}건: ${rows.map((r) => `${r.symbol} ${dirLabel(r.direction)} ${r.contracts}계약`).join(', ')}`, { key: `leftover:${follow.id}` });
}
