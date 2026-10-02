// AI 자동매매: 사용자(신청/설정/켜기끄기/비상), 관리자(승인/정지/수동 신호), 봇 신호 수신
import { Hono } from 'hono';
import type { AdminAutoBalance, AdminAutoBalancesResponse, AutoSettings, AutoSignal, AutoStateResponse, AutoStatus, Direction, SignalIngestRequest, Symbol } from '@easy-futures/shared';
import { AUTO_TERMS_VERSION, SYMBOLS, TERMS_VERSION } from '@easy-futures/shared';
import { WooxAdapter } from '../adapters/woox.js';
import { authMiddleware, type AppEnv } from '../auth.js';
import { timingSafeEqual } from '../crypto.js';
import { badRequest, HttpError } from '../errors.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { parseUserIdParam } from '../validate.js';
import { WooxClient } from '../woox/client.js';
import { applyAuto, autoTermsOutdated, getAutoRow, getAutoStatus, getSignal, insertSignal, listAutoUsers, listMyExecutions, listSignalExecutions, listSignals, rowToSettings, saveAutoSettings, setAutoStatus } from '../auto/db.js';
import { isAdmin } from './auth.js';
import { getActiveFollow } from '../copy/db.js';
import { findUserById, getCredsForUser, getSettings } from '../db.js';
import { adapterFor } from './trade.js';
import { enrichHistory, pnlByOrder } from '../history.js';
import { loadAutoTags } from '../auto/db.js';

// 실행 기록의 손익: 거래 내역(90일)을 사용자별 60초 캐시로 읽어 진입 주문 id 와 맞춘다 (AI 자동매매 화면이 15초마다 새로고침되므로)
const pnlCache = new Map<number, { at: number; value: Promise<Map<string, { pnl: number | null; closed: boolean }>> }>();
async function executionPnl(env: AppEnv['Bindings'], ctx: AppEnv['Variables']['ctx']): Promise<Map<string, { pnl: number | null; closed: boolean }>> {
  const key = ctx.user.id * 2 + (ctx.settings.mode === 'live' ? 1 : 0); // 모드별로 다른 캐시 (연습↔실거래 전환 직후 섞이지 않게)
  const hit = pnlCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  if (pnlCache.size > 1000) for (const [k, v] of pnlCache) if (Date.now() - v.at > 60_000) pnlCache.delete(k);
  const value = (async () => {
    const [contracts, tags] = await Promise.all([getContracts(), loadAutoTags(env.DB, ctx.user.id)]);
    const items = enrichHistory(await adapterFor(ctx, new PaperClient(env)).getHistory(90, contracts), tags);
    return pnlByOrder(items);
  })().catch(() => { pnlCache.delete(key); return new Map<string, { pnl: number | null; closed: boolean }>(); });
  pnlCache.set(key, { at: Date.now(), value });
  return value;
}

function parseAutoSettings(raw: unknown, current: AutoSettings): AutoSettings {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const next = { ...current };
  if ('pct' in b) { const v = Number(b.pct); if (!(v >= 1 && v <= 30)) throw badRequest('신호당 비율은 1~30% 사이여야 해요 (저점마다 최대 3번 나눠 들어가요)', 'BAD_PCT'); next.pct = Math.round(v); }
  if ('maxLeverage' in b) { const v = Number(b.maxLeverage); if (!Number.isInteger(v) || v < 1 || v > 50) throw badRequest('최대 배율은 1~50배 사이여야 해요', 'BAD_LEV'); next.maxLeverage = v; }
  if ('defaultSlRoi' in b) { const v = Number(b.defaultSlRoi); if (!(v >= 5 && v <= 30)) throw badRequest('기본 손절은 내 돈 기준 5~30% 사이여야 해요', 'BAD_SL'); next.defaultSlRoi = Math.round(v); }
  if ('enabled' in b) next.enabled = b.enabled === true;
  return next;
}

async function triggerRun(env: AppEnv['Bindings'], signalId: string): Promise<void> {
  const stub = env.AUTO.get(env.AUTO.idFromName('global'));
  const r = await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId }), headers: { 'content-type': 'application/json' } });
  if (!r.ok) log.warn('auto run failed', { signalId, status: r.status });
}

function parseSignal(raw: unknown, source: 'bot' | 'admin'): AutoSignal {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<SignalIngestRequest> & Record<string, unknown>;
  const id = typeof b.id === 'string' && /^[A-Za-z0-9:_\-.]{4,80}$/.test(b.id) ? b.id : null;
  if (!id) throw badRequest('신호 id 가 필요해요 (영숫자 4~80자)', 'BAD_ID');
  if (!(SYMBOLS as string[]).includes(String(b.symbol))) throw badRequest(`지원 종목은 ${SYMBOLS.join(', ')} 뿐이에요`, 'BAD_SYMBOL');
  const action = b.action === 'open' || b.action === 'add' || b.action === 'update' || b.action === 'close' ? b.action : null;
  if (!action) throw badRequest('action 은 open | add | update | close', 'BAD_ACTION');
  let direction: Direction | null = null;
  if (action === 'open' || action === 'add') { if (b.direction !== 'long' && b.direction !== 'short') throw badRequest('open/add 신호에는 direction(long|short)이 필요해요', 'BAD_DIRECTION'); direction = b.direction; }
  const slPrice = b.slPrice !== undefined && b.slPrice !== null ? Number(b.slPrice) : null;
  const tpPrice = b.tpPrice !== undefined && b.tpPrice !== null ? Number(b.tpPrice) : null;
  if (slPrice !== null && !(Number.isFinite(slPrice) && slPrice > 0)) throw badRequest('slPrice 오류', 'BAD_NUM');   // Infinity 차단 (감사 B23)
  if (tpPrice !== null && !(Number.isFinite(tpPrice) && tpPrice > 0)) throw badRequest('tpPrice 오류', 'BAD_NUM');
  const breakeven = b.breakeven === true;
  if (action === 'update' && slPrice === null && tpPrice === null && !breakeven && b.slRoi == null && b.tpRoi == null) throw badRequest('update 신호에는 slPrice/tpPrice/slRoi/tpRoi/breakeven 중 하나가 필요해요', 'BAD_UPDATE');
  const num = (v: unknown, lo: number, hi: number, name: string) => { if (v === undefined || v === null) return null; const n = Number(v); if (!(Number.isFinite(n) && n >= lo && n <= hi)) throw badRequest(`${name} 범위 오류`, 'BAD_NUM'); return n; };
  return {
    id, source, symbol: b.symbol as Symbol, action, direction,
    leverage: num(b.leverage, 1, 100, 'leverage') !== null ? Math.round(num(b.leverage, 1, 100, 'leverage')!) : null,
    slRoi: num(b.slRoi, 1, 95, 'slRoi'), tpRoi: num(b.tpRoi, 1, 1000, 'tpRoi'), slPrice, tpPrice, breakeven,
    note: typeof b.note === 'string' ? b.note.slice(0, 200) : null,
    createdAt: Date.now(), processedAt: null, followerCount: null, okCount: null, failCount: null,
  };
}

// ---------- 봇 → 서버 신호 수신 (HMAC) ----------
export const signalRoutes = new Hono<AppEnv>();
signalRoutes.post('/', async (c) => {
  const secret = c.env.AUTO_SIGNAL_SECRET;
  if (!secret) throw new HttpError(503, '신호 수신이 아직 설정되지 않았어요', 'NO_SECRET');
  const ts = c.req.header('x-timestamp') ?? '';
  const sig = c.req.header('x-signature') ?? '';
  const body = await c.req.text();
  if (!/^\d{10,13}$/.test(ts) || Math.abs(Date.now() - (ts.length === 10 ? Number(ts) * 1000 : Number(ts))) > 5 * 60_000) throw new HttpError(401, '타임스탬프가 맞지 않아요', 'BAD_TS');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
  const expected = Array.from(new Uint8Array(mac), (x) => x.toString(16).padStart(2, '0')).join('');
  if (sig.length !== expected.length || !timingSafeEqual(sig.toLowerCase(), expected)) throw new HttpError(401, '서명이 맞지 않아요', 'BAD_SIGNATURE');
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw badRequest('JSON 이 아니에요', 'BAD_JSON'); }
  const signal = parseSignal(parsed, 'bot');
  const inserted = await insertSignal(c.env.DB, signal);
  if (!inserted) return c.json({ ok: true, duplicate: true, id: signal.id });
  log.info('auto signal received', { id: signal.id, symbol: signal.symbol, action: signal.action, direction: signal.direction });
  c.executionCtx.waitUntil(triggerRun(c.env, signal.id));
  return c.json({ ok: true, id: signal.id }, 202);
});

// ---------- 사용자 ----------
export const autoRoutes = new Hono<AppEnv>();
autoRoutes.use('*', authMiddleware);

autoRoutes.get('/', async (c) => {
  const ctx = c.get('ctx');
  const [status, row, execs, pnl] = await Promise.all([getAutoStatus(c.env.DB, ctx.user.id), getAutoRow(c.env.DB, ctx.user.id), listMyExecutions(c.env.DB, ctx.user.id, 30), executionPnl(c.env, ctx)]);
  // 신호 목록(진입·손절가)은 승인된 사용자에게만 — 유료 정보가 무료 가입자에게 새지 않게 (감사 보안 M5)
  const signals = status === 'approved' ? await listSignals(c.env.DB, 20) : [];
  for (const e of execs) { const m = e.orderId ? pnl.get(e.orderId) : undefined; if (m) { e.pnl = m.pnl; e.closed = m.closed; } }
  const res: AutoStateResponse = { status, settings: rowToSettings(row), agreedAt: row?.agreed_at ?? null, note: row?.note ?? null, autoTermsOutdated: status === 'approved' && (await autoTermsOutdated(row)), recentSignals: signals, myExecutions: execs };
  return c.json(res);
});

/** 신청: 위험 동의 + 초기 설정. 신분증 인증·약관 동의가 끝난 계정만 */
autoRoutes.post('/apply', async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  if (b.agree !== true) throw badRequest('AI 자동매매 위험 안내에 동의해야 신청할 수 있어요', 'AGREE_REQUIRED');
  if (b.autoTermsVersion !== AUTO_TERMS_VERSION) throw badRequest('자동매매 특약을 끝까지 읽고 동의해야 신청할 수 있어요', 'AUTO_TERMS_REQUIRED');
  if (ctx.user.kycStatus !== 'approved') throw badRequest('신분증 확인이 끝나야 AI 자동매매를 신청할 수 있어요', 'KYC_REQUIRED');
  if (ctx.user.termsVersion !== TERMS_VERSION) throw badRequest('이용약관에 먼저 동의해 주세요', 'TERMS_OUTDATED');
  const s = parseAutoSettings(b, rowToSettings(await getAutoRow(c.env.DB, ctx.user.id)));
  await applyAuto(c.env.DB, ctx.user.id, s, AUTO_TERMS_VERSION);
  log.info('auto applied', { userId: ctx.user.id });
  return c.json({ ok: true, status: 'pending' as AutoStatus });
});

autoRoutes.put('/settings', async (c) => {
  const ctx = c.get('ctx');
  const status = await getAutoStatus(c.env.DB, ctx.user.id);
  const cur = rowToSettings(await getAutoRow(c.env.DB, ctx.user.id));
  const next = parseAutoSettings(await readJson(c), cur);
  if (next.enabled && status !== 'approved') throw new HttpError(403, '관리자 승인 후에 켤 수 있어요', 'NOT_APPROVED');
  // 실거래는 API 키가 있어야 신호가 실행된다 — 키 없이 켜 두면 "켜져 있어요"인데 전부 건너뛰는 상태가 되므로 막는다 (연습 엔진은 관리자 테스트용이라 예외)
  if (next.enabled && ctx.settings.mode === 'live' && !ctx.creds) throw new HttpError(400, '거래소 API 키를 먼저 연결해 주세요', 'NO_API_KEY');
  // 계좌 하나에 신호원 둘은 금지: 고수 따라하기 중이면 AI 자동매매를 켤 수 없다 (docs/copy-trading.md §1)
  if (next.enabled && !cur.enabled && (await getActiveFollow(c.env.DB, ctx.user.id))) throw new HttpError(409, '고수 따라하기를 먼저 멈춘 뒤 AI 자동매매를 켤 수 있어요', 'COPY_ACTIVE');
  await saveAutoSettings(c.env.DB, ctx.user.id, next);
  return c.json(next);
});

/** 비상: AI 자동매매 끄기 + 현재 모드의 모든 포지션 정리 */
autoRoutes.post('/panic', async (c) => {
  const ctx = c.get('ctx');
  const cur = rowToSettings(await getAutoRow(c.env.DB, ctx.user.id));
  await saveAutoSettings(c.env.DB, ctx.user.id, { ...cur, enabled: false });
  const paper = new PaperClient(c.env);
  const contracts = await getContracts();
  const closed: string[] = []; const failed: string[] = [];
  if (ctx.settings.mode === 'live') {
    if (!ctx.creds) return c.json({ ok: true, closed, failed, note: 'API 키 없음' });
    const adapter = new WooxAdapter(new WooxClient({ credentials: ctx.creds, gate: makeRateGate(c.env) }));
    const acc = await adapter.getAccount(contracts, {});
    for (const p of acc.positions) { try { await adapter.closePosition(p.symbol, contracts[p.symbol]); closed.push(p.symbol); } catch (e) { failed.push(`${p.symbol}: ${(e as Error).message}`); } }
  } else {
    const s = await paper.state(ctx.user.id, true);
    for (const p of s.positions) { try { await paper.close(ctx.user.id, p.symbol); closed.push(p.symbol); } catch (e) { failed.push(`${p.symbol}: ${(e as Error).message}`); } }
  }
  log.info('auto panic', { userId: ctx.user.id, closed, failed });
  return c.json({ ok: true, closed, failed });
});

// ---------- 관리자 ----------
export const adminAutoRoutes = new Hono<AppEnv>();
adminAutoRoutes.use('*', authMiddleware, async (c, next) => {
  if (!isAdmin(c.env, c.get('ctx').user.loginId)) throw new HttpError(403, '관리자만 볼 수 있어요', 'FORBIDDEN');
  await next();
});
adminAutoRoutes.get('/', async (c) => {
  const [pending, approved, suspended, rejected, signals] = await Promise.all([listAutoUsers(c.env.DB, 'pending'), listAutoUsers(c.env.DB, 'approved'), listAutoUsers(c.env.DB, 'suspended'), listAutoUsers(c.env.DB, 'rejected'), listSignals(c.env.DB, 30)]);
  return c.json({ pending, approved, suspended, rejected, signals, signalSecretSet: !!c.env.AUTO_SIGNAL_SECRET });
});
/** 관리자: 승인 사용자 전원의 실시간 선물 잔고(연습=연습 엔진, 실거래=거래소 본인 키). 55초 모듈 캐시(관리자 1명), 동시 5명씩 */
const BALANCES_TTL = 55_000;
const BALANCES_BATCH = 5; // Worker 호출당 동시 외부 연결 6개 제한
let balancesCache: { at: number; value: Promise<AdminAutoBalancesResponse> } | null = null;
async function fetchAutoBalances(env: AppEnv['Bindings']): Promise<AdminAutoBalancesResponse> {
  const paper = new PaperClient(env);
  const [users, contracts, pr] = await Promise.all([listAutoUsers(env.DB, 'approved'), getContracts(), paper.prices()]);
  const one = async (u: { userId: number; loginId: string }): Promise<AdminAutoBalance> => {
    const base = { userId: u.userId, loginId: u.loginId };
    try {
      const settings = await getSettings(env, u.userId);
      if (settings.mode === 'live') {
        const creds = await getCredsForUser(env, u.userId);
        if (!creds) return { ...base, mode: 'live', wallet: null, positions: [], error: 'API 키 없음' };
        const acc = await new WooxAdapter(new WooxClient({ credentials: creds, gate: makeRateGate(env) })).getAccount(contracts, pr.prices);
        return { ...base, mode: 'live', wallet: acc.wallet, positions: acc.positions, error: null };
      }
      const s = await paper.state(u.userId, true);
      return { ...base, mode: 'paper', wallet: s.wallet, positions: s.positions, error: null };
    } catch (e) {
      log.warn('admin auto balance fetch failed', { userId: u.userId, message: (e as Error).message });
      return { ...base, mode: 'live', wallet: null, positions: [], error: '조회 실패' };
    }
  };
  const balances: AdminAutoBalance[] = [];
  for (let i = 0; i < users.length; i += BALANCES_BATCH) balances.push(...(await Promise.all(users.slice(i, i + BALANCES_BATCH).map(one))));
  return { balances, cachedAt: Date.now(), serverTime: Date.now() };
}
adminAutoRoutes.get('/balances', async (c) => {
  const now = Date.now();
  if (!balancesCache || now - balancesCache.at >= BALANCES_TTL) {
    const value = fetchAutoBalances(c.env).catch((e) => { balancesCache = null; throw e; });
    balancesCache = { at: now, value };
  }
  const res = await balancesCache.value;
  return c.json({ ...res, serverTime: Date.now() });
});
adminAutoRoutes.post('/users/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  const status: AutoStatus | null = b.action === 'approve' ? 'approved' : b.action === 'suspend' ? 'suspended' : b.action === 'reject' ? 'rejected' : null;
  if (!status) throw badRequest('approve | suspend | reject', 'BAD_ACTION');
  const target = await findUserById(c.env.DB, userId);
  if (!target || target.deleted_at) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : null;
  if (!(await setAutoStatus(c.env.DB, userId, status, c.get('ctx').user.loginId, note))) throw new HttpError(409, '신청(대기) 또는 중지 상태에서만 승인할 수 있어요', 'NOT_PENDING');
  log.info('auto status set', { userId, status, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, status });
});
/** 관리자: 신호 1건의 사용자별 실행 결과 (누가 왜 실패했는지) — 감사 M5 */
adminAutoRoutes.get('/signals/:id/executions', async (c) => {
  const id = c.req.param('id');
  if (!/^[A-Za-z0-9:_\-.]{4,80}$/.test(id)) throw badRequest('신호 id 오류', 'BAD_ID');
  const [signal, executions] = await Promise.all([getSignal(c.env.DB, id), listSignalExecutions(c.env.DB, id)]);
  if (!signal) throw new HttpError(404, '신호가 없어요', 'NO_SIGNAL');
  return c.json({ signal, executions });
});
/** 관리자: 중단된 신호 재실행 — 아직 실행 기록이 없는 사용자에게만 (감사 M10) */
adminAutoRoutes.post('/signals/:id/rerun', async (c) => {
  const id = c.req.param('id');
  const signal = await getSignal(c.env.DB, id);
  if (!signal) throw new HttpError(404, '신호가 없어요', 'NO_SIGNAL');
  if (Date.now() - signal.createdAt > 15 * 60_000) throw badRequest('15분이 지난 신호는 다시 실행할 수 없어요 (시세가 달라졌어요)', 'TOO_OLD');
  await c.env.DB.prepare('UPDATE auto_signals SET processed_at = NULL WHERE id = ?').bind(id).run();
  log.info('admin signal rerun', { id, by: c.get('ctx').user.loginId });
  const stub = c.env.AUTO.get(c.env.AUTO.idFromName('global'));
  const r = await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: id }), headers: { 'content-type': 'application/json' } });
  return c.json({ ok: true, result: await r.json() });
});
/** 관리자 수동 신호 (테스트·긴급용). 봇 신호와 같은 경로로 실행 */
adminAutoRoutes.post('/signal', async (c) => {
  const b = await readJson(c);
  const signal = parseSignal({ ...b, id: typeof b.id === 'string' && b.id ? b.id : `admin-${Date.now()}` }, 'admin');
  const inserted = await insertSignal(c.env.DB, signal);
  if (!inserted) throw badRequest('같은 id 의 신호가 이미 있어요', 'DUPLICATE');
  log.info('admin signal', { id: signal.id, by: c.get('ctx').user.loginId, action: signal.action, symbol: signal.symbol });
  const result = await (async () => { const stub = c.env.AUTO.get(c.env.AUTO.idFromName('global')); const r = await stub.fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: signal.id }), headers: { 'content-type': 'application/json' } }); return r.json(); })();
  return c.json({ ok: true, id: signal.id, result });
});
