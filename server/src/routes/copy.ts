// 카피 트레이딩 API — docs/copy-trading.md §5. 사용자(/api/copy)·마스터 대시보드·관리자(/api/admin/copy)
// 원칙: 목록·상태·대시보드는 거래소를 부르지 않는다(장부 + 시세). 감시/실행 DO 는 try/catch 로 부르고 없으면 조용히 폴백.
import { Hono } from 'hono';
import type { AdminCopyFollow, AdminCopyMaster, AdminCopyResponse, ContractInfo, CopyDashboardResponse, CopyEligibility, CopyExecution, CopyFollowMe, CopyFollowSettings, CopyFollowerRow, CopyMasterCard, CopyMasterHide, CopyMasterMe, CopyMasterProfile, CopyMasterStatus, CopyPositionView, CopyStateResponse, Direction, Price, Symbol } from '@easy-futures/shared';
import { COPY_LIMITS, COPY_TERMS_VERSION, DEFAULT_COPY_MASTER_HIDE, MASTER_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import { authMiddleware, type AppEnv } from '../auth.js';
import { getAutoRow } from '../auto/db.js';
import { copyStub } from '../copy/CopyTrader.js';
import {
  applyMaster, clearMasterState, copyTermsOutdated, createFollow, deleteCopyPositions, followerCounts, getActiveFollow, getEvent, getFollow, getLatestFollow, getMaster, getMasterMeta, getMasterState, getMasterStats,
  listCopyPositions, listCopyPositionsOfMaster, listEventExecutions, listEvents, listFollowersOfMaster, listFollowsAdmin, listMasterStats, listMasters, listMastersAdmin, listMyCopyExecutions,
  listOpenMasterPositions, listRecentEvents, lastExecutionOf, masterTermsOutdated, setMasterStatus, stopFollow, stopFollowsOfMaster, updateFollowSettings, updateMasterHide, updateMasterIntro,
  type CopyPositionRow, type MasterRow, type MasterStats, reagreeMaster, reagreeFollow, resetMasterStats, isPausedGlobal, setCopyFlag, setMasterPaused, PAUSED_GLOBAL_KEY,
  ackLeftovers, avgSlippagePct, countLeftoversByFollow, listLeftovers, snapshotLeftovers } from '../copy/db.js';
import { notifyLeftovers } from '../copy/notify.js';
import { masterStub } from '../copy/MasterWatcher.js';
import { lossLimitUsed } from '../copy/sizing.js';
import { refreshMasterStats } from '../copy/stats.js';
import { findUserById, type UserContext } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { enrichHistory, pnlByOrder } from '../history.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { parseUserIdParam } from '../validate.js';
import { isAdmin } from './auth.js';
import { adapterFor } from './trade.js';
import { WooxClient } from '../woox/client.js';
import { getCredsForUser } from '../db.js';

type Env = AppEnv['Bindings'];
type Prices = Partial<Record<Symbol, Price>>;
type Contracts = Record<Symbol, ContractInfo>;

// ---------- 공용 헬퍼 ----------
/** 아이디 마스킹: 앞 2자 + *** + 끝 1자 (4자 이하는 앞 1자 + ***) — 마스터 대시보드·이벤트 결과에 쓴다. 드러나는 글자는 최대 3자 */
export function maskLoginId(loginId: string): string {
  if (loginId.length <= 4) return loginId.slice(0, 1) + '***';
  return loginId.slice(0, 2) + '***' + loginId.slice(-1);
}

/** 응답 뒤에도 끝나야 하는 일(관리자 알림) — 실행 컨텍스트가 없으면(단위 테스트) 그냥 띄운다 */
function background(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, p: Promise<unknown>): void {
  try { c.executionCtx.waitUntil(p); } catch { void p; }
}

/** DO 호출 — 절대 던지지 않는다. 미구현(501)·오류는 ok=false */
async function callDo(stub: DurableObjectStub, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await stub.fetch(url, body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    let data: Record<string, unknown> = {};
    try { data = (await r.json()) as Record<string, unknown>; } catch { /* 본문 없음 */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: (e as Error).message } };
  }
}
async function callDoGet(stub: DurableObjectStub, url: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await stub.fetch(url);
    let data: Record<string, unknown> = {};
    try { data = (await r.json()) as Record<string, unknown>; } catch { /* 본문 없음 */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: (e as Error).message } };
  }
}

/** 시세 + 계약 정보 (실패해도 빈 값 — 화면은 뜨게) */
async function marketData(env: Env): Promise<{ prices: Prices; contracts: Contracts }> {
  const [contracts, pr] = await Promise.all([getContracts(), new PaperClient(env).prices().catch(() => ({ prices: {} as Prices }))]);
  return { prices: pr.prices, contracts };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** 장부 포지션 → 화면 행 (시세로 미실현 계산) */
function positionView(p: CopyPositionRow, prices: Prices, contracts: Contracts): CopyPositionView {
  const mark = prices[p.symbol]?.mark || prices[p.symbol]?.last || 0;
  const size = contracts[p.symbol]?.contractSize ?? 0;
  const unrealizedPnl = mark > 0 ? r2((mark - p.entryPrice) * p.contracts * size * (p.direction === 'long' ? 1 : -1)) : 0;
  return { symbol: p.symbol, direction: p.direction, contracts: p.contracts, entryPrice: p.entryPrice, leverage: p.leverage, markPrice: mark, unrealizedPnl, openedAt: p.openedAt, stopLossPrice: p.slPrice ?? null, takeProfitPrice: p.tpPrice ?? null };
}

const ZERO_STATS: Omit<MasterStats, 'updatedAt'> = { days30Pnl: 0, days30Roi: 0, winRate: 0, trades: 0, recent: [] };
/** 전체 카드(고수 본인 대시보드·관리자용). 손익 금액(USDT)은 withPnl 일 때만. 다른 사용자에게 보낼 때는 publicCard 로 숨긴 항목을 뺀다 */
function masterCard(m: MasterRow, followers: number, stats: MasterStats | null | undefined, positions: { symbol: Symbol; direction: Direction }[], withPnl = false): CopyMasterCard {
  const s = stats ?? ZERO_STATS;
  return { userId: m.userId, nickname: m.nickname, intro: m.intro, since: m.decidedAt ?? m.appliedAt, followers, ...(withPnl ? { days30Pnl: r2(s.days30Pnl) } : {}), days30Roi: r2(s.days30Roi), winRate: r2(s.winRate), trades: s.trades, hide: m.hide, positions };
}
/** 다른 사용자에게 보이는 카드: 고수가 숨긴 항목(팔로워 수·거래 횟수·승률·30일 수익률)은 아예 싣지 않는다. hide 로 무엇이 비공개인지만 알린다 */
function publicCard(card: CopyMasterCard): CopyMasterCard {
  const c = { ...card };
  delete c.days30Pnl;
  if (c.hide.followers) delete c.followers;
  if (c.hide.trades) delete c.trades;
  if (c.hide.winRate) delete c.winRate;
  if (c.hide.roi) delete c.days30Roi;
  return c;
}
function masterMe(m: MasterRow | null): CopyMasterMe | null {
  if (!m) return null;
  return { status: m.status, nickname: m.nickname, intro: m.intro, note: m.note, appliedAt: m.appliedAt, masterTermsOutdated: masterTermsOutdated(m), hide: m.hide };
}

/** 팔로우 설정 파싱. partial=true 면 있는 항목만 검증(PUT) */
function parseFollowSettings(b: Record<string, unknown>, base: CopyFollowSettings, partial: boolean): CopyFollowSettings {
  const next = { ...base };
  const has = (k: string) => partial ? k in b : true;
  if (has('copyAmount')) {
    const v = Number(b.copyAmount);
    if (!(v >= COPY_LIMITS.copyAmountMin && v <= COPY_LIMITS.copyAmountMax)) throw badRequest(`따라갈 돈은 ${COPY_LIMITS.copyAmountMin}~${COPY_LIMITS.copyAmountMax.toLocaleString()} USDT 사이여야 해요`, 'BAD_AMOUNT');
    next.copyAmount = Math.floor(v * 100) / 100;
  }
  if (has('lossLimitPct')) {
    const v = Number(b.lossLimitPct); const [lo, hi] = COPY_LIMITS.lossLimitPct;
    if (!(v >= lo && v <= hi)) throw badRequest(`손실 한도는 따라갈 돈의 ${lo}~${hi}% 사이여야 해요`, 'BAD_LOSS_LIMIT');
    next.lossLimitPct = Math.round(v);
  }
  if (has('maxLeverage')) {
    const v = Number(b.maxLeverage); const [lo, hi] = COPY_LIMITS.maxLeverage;
    if (!Number.isInteger(v) || v < lo || v > hi) throw badRequest(`최대 배율은 ${lo}~${hi}배 사이여야 해요`, 'BAD_LEV');
    next.maxLeverage = v;
  }
  if (has('slRoi')) {
    const v = Number(b.slRoi); const [lo, hi] = COPY_LIMITS.slRoi;
    if (!(v >= lo && v <= hi)) throw badRequest(`손절은 내 돈 기준 ${lo}~${hi}% 사이여야 해요`, 'BAD_SL');
    next.slRoi = Math.round(v);
  }
  return next;
}

/** 팔로워 자격 공통 검사 (신청·팔로우·설정 변경) */
function requireBasics(ctx: UserContext): void {
  if (ctx.user.mustChangePw) throw new HttpError(403, '먼저 새 비밀번호를 정해 주세요', 'MUST_CHANGE_PASSWORD');
  if (ctx.user.kycStatus !== 'approved') throw new HttpError(403, '신분증 확인이 끝나야 쓸 수 있어요', 'KYC_REQUIRED');
  if (ctx.user.termsVersion !== TERMS_VERSION) throw new HttpError(403, '바뀐 이용약관에 먼저 동의해 주세요', 'TERMS_OUTDATED');
}

/** 지금 쓸 수 있는 돈 (현재 모드 계좌). 조회 실패 → 503 */
async function availableOf(env: Env, ctx: UserContext): Promise<number> {
  const paper = new PaperClient(env);
  try {
    const { prices, contracts } = await marketData(env);
    const acc = await adapterFor(ctx, paper).getAccount(contracts, prices);
    return acc.wallet.available;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 403)) throw e; // 키 없음·신분증 미승인 같은 자격 오류는 그대로
    log.warn('copy account fetch failed', { userId: ctx.user.id, message: (e as Error).message });
    throw new HttpError(503, '계좌를 확인할 수 없어요. 잠시 후 다시 해 주세요', 'ACCOUNT_UNAVAILABLE');
  }
}

// ---------- 마스터 최근 거래·통계: copy/stats.ts (D1 updated_at 5분 게이트, 감시 DO 알람도 같은 함수로 갱신) ----------
type Recent = NonNullable<CopyMasterProfile['recent']>;
async function masterRecent(env: Env, masterId: number): Promise<Recent> {
  const s = await refreshMasterStats(env, masterId);
  return s?.recent ?? [];
}

// 내 카피 실행의 손익: 거래 내역(90일) 60초 캐시 — auto.ts executionPnl 과 같은 방식
const execPnlCache = new Map<number, { at: number; value: Promise<Map<string, { pnl: number | null; closed: boolean }>> }>();
function executionPnl(env: Env, ctx: UserContext): Promise<Map<string, { pnl: number | null; closed: boolean }>> {
  const key = ctx.user.id * 2 + (ctx.settings.mode === 'live' ? 1 : 0);
  const hit = execPnlCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  if (execPnlCache.size > 1000) for (const [k, v] of execPnlCache) if (Date.now() - v.at > 60_000) execPnlCache.delete(k);
  const value = (async () => {
    const contracts = await getContracts();
    return pnlByOrder(enrichHistory(await adapterFor(ctx, new PaperClient(env)).getHistory(90, contracts)));
  })().catch(() => { execPnlCache.delete(key); return new Map<string, { pnl: number | null; closed: boolean }>(); });
  execPnlCache.set(key, { at: Date.now(), value });
  return value;
}

const RESERVED_NICK = /관리자|운영자|admin|easyfutures|easy ?futures|official|공식/i;

// ---------- 사용자 ----------
export const copyRoutes = new Hono<AppEnv>();
copyRoutes.use('*', authMiddleware);

/** 내 상태 + 고수 목록. 거래소 호출 없음 */
copyRoutes.get('/', async (c) => {
  const ctx = c.get('ctx');
  const db = c.env.DB;
  const [master, latest, autoRow, approved, counts, stats, openPos, { prices, contracts }] = await Promise.all([
    getMaster(db, ctx.user.id), getLatestFollow(db, ctx.user.id), getAutoRow(db, ctx.user.id), listMasters(db, 'approved'), followerCounts(db), listMasterStats(db), listOpenMasterPositions(db), marketData(c.env),
  ]);
  let follow: CopyFollowMe | null = null;
  if (latest) {
    const [fm, rows, leftoverRows, avgSlip] = await Promise.all([
      getMaster(db, latest.masterId), latest.status === 'active' ? listCopyPositions(db, ctx.user.id) : Promise.resolve([] as CopyPositionRow[]),
      listLeftovers(db, ctx.user.id, true, latest.id).catch(() => []), avgSlippagePct(db, ctx.user.id).catch(() => null),
    ]);
    const positions = rows.filter((p) => p.masterId === latest.masterId).map((p) => positionView(p, prices, contracts));
    const unrealizedPnl = r2(positions.reduce((a, p) => a + p.unrealizedPnl, 0));
    const leftovers = leftoverRows.map((l) => ({ symbol: l.symbol, direction: l.direction, contracts: l.contracts, entryPrice: l.entryPrice, leverage: l.leverage, reason: l.reason, createdAt: l.createdAt }));
    follow = {
      id: latest.id, masterId: latest.masterId, masterNickname: fm?.nickname ?? '(삭제된 고수)', status: latest.status, mode: latest.mode, settings: latest.settings,
      copyAmountNow: latest.copyAmountNow, realizedPnl: r2(latest.realizedPnl), unrealizedPnl, lossLimitUsed: r2(lossLimitUsed(latest.settings.copyAmount, latest.settings.lossLimitPct, latest.realizedPnl, unrealizedPnl)),
      positions, startedAt: latest.startedAt, stoppedAt: latest.stoppedAt, stopReason: latest.stopReason, copyTermsOutdated: copyTermsOutdated(latest),
      ...(leftovers.length ? { leftovers } : {}), avgSlippagePct: avgSlip,
    };
  }
  const eligible: CopyEligibility = { kyc: ctx.user.kycStatus === 'approved', live: ctx.settings.mode === 'live', apiKey: !!ctx.creds, autoOn: !!autoRow?.enabled, termsCurrent: ctx.user.termsVersion === TERMS_VERSION };
  // 정렬은 전체 값으로 하고, 보낼 때 다른 고수의 숨긴 항목을 뺀다 (내 카드는 그대로 — 내 숫자는 내가 본다)
  const masters = approved.map((m) => masterCard(m, counts.get(m.userId) ?? 0, stats.get(m.userId), openPos.get(m.userId) ?? []))
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0) || (b.days30Roi ?? 0) - (a.days30Roi ?? 0))
    .map((card) => (card.userId === ctx.user.id ? card : publicCard(card)));
  const res: CopyStateResponse = { me: { master: masterMe(master), follow, eligible }, masters, serverTime: Date.now() };
  return c.json(res);
});

/** 고수 신청: 닉네임·소개·마스터 약관 동의. 신분증 승인 + 약관 최신 + 실거래·API 키 (관리자는 연습도 허용 — 테스트용) */
copyRoutes.post('/master/apply', async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  const nickname = typeof b.nickname === 'string' ? b.nickname.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const [nlo, nhi] = COPY_LIMITS.nickname;
  if (nickname.length < nlo || nickname.length > nhi) throw badRequest(`이름은 ${nlo}~${nhi}자로 해 주세요`, 'BAD_NICKNAME');
  if (/[\p{C}]/u.test(nickname)) throw badRequest('이름에 쓸 수 없는 글자가 있어요', 'BAD_NICKNAME');
  if (RESERVED_NICK.test(nickname)) throw badRequest('그 이름은 쓸 수 없어요 (운영자를 흉내 내는 이름)', 'BAD_NICKNAME');
  const intro = typeof b.intro === 'string' ? b.intro.trim() : '';
  if (intro.length > COPY_LIMITS.introMax) throw badRequest(`소개는 ${COPY_LIMITS.introMax}자까지예요`, 'BAD_INTRO');
  if (b.agree !== true) throw badRequest('고수 약관에 동의해야 신청할 수 있어요', 'AGREE_REQUIRED');
  if (b.masterTermsVersion !== MASTER_TERMS_VERSION) throw badRequest('고수 약관을 끝까지 읽고 동의해야 신청할 수 있어요', 'TERMS_OUTDATED');
  requireBasics(ctx);
  if (!isAdmin(c.env, ctx.user.loginId)) {
    if (ctx.settings.mode !== 'live') throw new HttpError(403, '고수는 실거래 계좌로만 할 수 있어요. 설정에서 실거래로 바꾼 뒤 신청해 주세요', 'LIVE_REQUIRED');
    if (!ctx.creds) throw new HttpError(403, '고수는 API 키가 있어야 해요. 먼저 키를 등록해 주세요', 'NO_API_KEY');
  }
  // 이미 고수(승인·대기·중지)인데 약관 버전만 올라간 경우: 상태를 바꾸지 않고 재동의만 기록 (웹의 재동의 경로)
  const existing = await getMaster(c.env.DB, ctx.user.id);
  if (existing && existing.status !== 'rejected' && existing.termsVersion !== MASTER_TERMS_VERSION) {
    await reagreeMaster(c.env.DB, ctx.user.id, MASTER_TERMS_VERSION, intro || null);
    return c.json({ ok: true, status: existing.status, reagreed: true });
  }
  await applyMaster(c.env.DB, ctx.user.id, nickname, intro, MASTER_TERMS_VERSION);
  log.info('copy master applied', { userId: ctx.user.id, nickname });
  return c.json({ ok: true, status: 'pending' as CopyMasterStatus }, 202);
});

/** 소개 수정 */
copyRoutes.put('/master', async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  const intro = typeof b.intro === 'string' ? b.intro.trim() : '';
  if (intro.length > COPY_LIMITS.introMax) throw badRequest(`소개는 ${COPY_LIMITS.introMax}자까지예요`, 'BAD_INTRO');
  if (!(await updateMasterIntro(c.env.DB, ctx.user.id, intro))) throw new HttpError(404, '고수 신청 기록이 없어요', 'NOT_MASTER');
  return c.json({ ok: true, intro });
});

/** 공개 숨김: `{ hide: Partial<CopyMasterHide> }` (true/false 만). 숨긴 항목은 다른 사용자의 목록 카드·프로필에서 빠진다. 본인 대시보드·관리자는 계속 본다 */
copyRoutes.put('/master/hide', async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  const patch = b.hide;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('숨김 설정이 올바르지 않아요', 'BAD_HIDE');
  const master = await getMaster(c.env.DB, ctx.user.id);
  if (!master) throw new HttpError(404, '고수 신청 기록이 없어요', 'NOT_MASTER');
  const hide: CopyMasterHide = { ...master.hide };
  for (const k of Object.keys(DEFAULT_COPY_MASTER_HIDE) as (keyof CopyMasterHide)[]) {
    if (!(k in patch)) continue;
    const v = (patch as Record<string, unknown>)[k];
    if (typeof v !== 'boolean') throw badRequest('숨김 설정은 켬/끔(true/false)만 돼요', 'BAD_HIDE');
    hide[k] = v;
  }
  if (!(await updateMasterHide(c.env.DB, ctx.user.id, hide))) throw new HttpError(404, '고수 신청 기록이 없어요', 'NOT_MASTER');
  log.info('copy master hide updated', { userId: ctx.user.id, hide });
  return c.json({ ok: true, hide });
});

/** 고수 대시보드 (승인된 고수만). 거래소 호출 없음 — 장부 + 시세 */
copyRoutes.get('/master/dashboard', async (c) => {
  const ctx = c.get('ctx');
  const db = c.env.DB;
  const master = await getMaster(db, ctx.user.id);
  if (!master || master.status !== 'approved') throw new HttpError(403, '승인된 고수만 볼 수 있어요', 'NOT_MASTER');
  const [rows, posRows, events, stats, state, { prices, contracts }, watcherRes] = await Promise.all([
    listFollowersOfMaster(db, ctx.user.id), listCopyPositionsOfMaster(db, ctx.user.id), listEvents(db, ctx.user.id, 30), getMasterStats(db, ctx.user.id), getMasterState(db, ctx.user.id), marketData(c.env),
    callDoGet(masterStub(c.env, ctx.user.id), 'https://master/status'),
  ]);
  const byFollower = new Map<number, CopyPositionView[]>();
  for (const p of posRows) { const l = byFollower.get(p.followerId) ?? []; l.push(positionView(p, prices, contracts)); byFollower.set(p.followerId, l); }
  const followers: CopyFollowerRow[] = await Promise.all(rows.map(async (f) => {
    const positions = byFollower.get(f.followerId) ?? [];
    return {
      followId: f.id, maskedId: maskLoginId(f.followerLoginId), mode: f.mode, copyAmount: f.settings.copyAmount, copyAmountNow: f.copyAmountNow, realizedPnl: r2(f.realizedPnl),
      unrealizedPnl: r2(positions.reduce((a, p) => a + p.unrealizedPnl, 0)), positions, startedAt: f.startedAt, lastExecution: await lastExecutionOf(db, f.followerId, ctx.user.id),
    };
  }));
  const openPos = [...state.values()].filter((s) => s.contracts > 0 && s.direction).map((s) => ({ symbol: s.symbol, direction: s.direction! }));
  let watcher: CopyDashboardResponse['watcher'];
  if (watcherRes.ok && typeof watcherRes.data.wsOk === 'boolean') {
    watcher = { wsOk: watcherRes.data.wsOk, lastPollAt: typeof watcherRes.data.lastPollAt === 'number' ? watcherRes.data.lastPollAt : null, lastError: typeof watcherRes.data.lastError === 'string' ? watcherRes.data.lastError : null };
  } else {
    const meta = await getMasterMeta(db, ctx.user.id);
    watcher = { wsOk: meta.wsOk, lastPollAt: meta.lastPollAt, lastError: meta.lastError };
  }
  const res: CopyDashboardResponse = { followers, events, stats: masterCard(master, rows.length, stats, openPos, true), watcher, serverTime: Date.now() };
  return c.json(res);
});

/** 이벤트 1건의 팔로워별 결과 (내 이벤트만, 아이디 마스킹) */
copyRoutes.get('/master/events/:id/executions', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!/^[A-Za-z0-9:_\-.]{4,120}$/.test(id)) throw badRequest('이벤트 id 오류', 'BAD_ID');
  const event = await getEvent(c.env.DB, id);
  if (!event) throw new HttpError(404, '이벤트가 없어요', 'NO_EVENT');
  if (event.masterId !== ctx.user.id) throw new HttpError(403, '내 이벤트만 볼 수 있어요', 'FORBIDDEN');
  const executions = (await listEventExecutions(c.env.DB, id)).map((e) => ({ ...e, loginId: maskLoginId(e.loginId) }));
  return c.json({ event, executions });
});

/** 고수 프로필: 카드 + 최근 마감 거래 10건(내 돈 기준 %). 통계는 5분마다 갱신 */
copyRoutes.get('/masters/:id', async (c) => {
  const id = parseUserIdParam(c.req.param('id'));
  const db = c.env.DB;
  const master = await getMaster(db, id);
  if (!master || master.status !== 'approved') throw new HttpError(404, '그 고수를 찾을 수 없어요', 'NO_MASTER');
  const self = id === c.get('ctx').user.id;   // 고수 본인은 숨긴 항목도 본다
  // 최근 거래를 숨겼으면 거래소 조회 자체를 하지 않는다
  const recent = self || !master.hide.recent ? await masterRecent(c.env, id) : undefined;
  const [counts, stats, state] = await Promise.all([followerCounts(db), getMasterStats(db, id), getMasterState(db, id)]);
  const positions = [...state.values()].filter((s) => s.contracts > 0 && s.direction).map((s) => ({ symbol: s.symbol, direction: s.direction! }));
  const card = masterCard(master, counts.get(id) ?? 0, stats, positions);
  const res: CopyMasterProfile = { ...(self ? card : publicCard(card)), ...(recent ? { recent } : {}) };
  return c.json(res);
});

/** 따라하기 시작 */
copyRoutes.post('/follow', async (c) => {
  const ctx = c.get('ctx');
  const db = c.env.DB;
  const b = await readJson(c);
  const settings = parseFollowSettings(b, { copyAmount: NaN, lossLimitPct: NaN, maxLeverage: NaN, slRoi: NaN }, false);
  if (b.agree !== true) throw badRequest('카피 트레이딩 특약에 동의해야 시작할 수 있어요', 'AGREE_REQUIRED');
  if (b.copyTermsVersion !== COPY_TERMS_VERSION) throw badRequest('카피 트레이딩 특약을 끝까지 읽고 동의해야 시작할 수 있어요', 'TERMS_OUTDATED');
  requireBasics(ctx);
  const masterId = Number(b.masterId);
  if (!Number.isInteger(masterId) || masterId <= 0) throw badRequest('고수를 골라 주세요', 'BAD_MASTER');
  if (masterId === ctx.user.id) throw new HttpError(409, '자기 자신을 따라갈 수는 없어요', 'COPY_SELF');
  const master = await getMaster(db, masterId);
  if (!master || master.status !== 'approved') throw new HttpError(404, '그 고수를 찾을 수 없어요 (승인 전이거나 중지됨)', 'NO_MASTER');
  if (await getActiveFollow(db, ctx.user.id)) throw new HttpError(409, '이미 따라가는 고수가 있어요. 먼저 멈춘 뒤 다시 골라 주세요', 'ALREADY_FOLLOWING');
  // 고수끼리 서로(또는 돌아서) 따라가면 신호가 증폭된다 — 고수(신청·승인·중지)는 팔로워가 될 수 없고, 나를 따라가는 고수는 따라갈 수 없다
  const me = await getMaster(db, ctx.user.id);
  if (me && me.status !== 'rejected') throw new HttpError(409, '고수끼리 서로 따라할 수 없어요', 'COPY_CYCLE');
  const theirs = await getActiveFollow(db, masterId);
  if (theirs && theirs.masterId === ctx.user.id) throw new HttpError(409, '고수끼리 서로 따라할 수 없어요', 'COPY_CYCLE');
  const autoRow = await getAutoRow(db, ctx.user.id);
  if (autoRow?.enabled) throw new HttpError(409, 'AI 자동매매를 끈 뒤 따라하기를 시작할 수 있어요', 'AUTO_ON');
  const mode = ctx.settings.mode;
  if (mode === 'live' && !ctx.creds) throw new HttpError(403, '실거래로 따라가려면 먼저 API 키를 등록해 주세요', 'NO_API_KEY');
  const available = await availableOf(c.env, ctx);
  if (settings.copyAmount > available) throw badRequest(`따라갈 돈이 지금 쓸 수 있는 돈(${r2(available)} USDT)보다 많아요`, 'INSUFFICIENT');
  const followId = await createFollow(db, ctx.user.id, masterId, mode, settings, COPY_TERMS_VERSION);
  log.info('copy follow started', { userId: ctx.user.id, masterId, mode, copyAmount: settings.copyAmount });
  return c.json({ ok: true, followId });
});

/** 따라하기 설정 변경 (부분) */
copyRoutes.put('/follow', async (c) => {
  const ctx = c.get('ctx');
  const db = c.env.DB;
  const cur = await getActiveFollow(db, ctx.user.id);
  if (!cur) throw new HttpError(404, '따라가는 중이 아니에요', 'NOT_FOLLOWING');
  const b = await readJson(c);
  // 특약 재동의 (버전이 올라간 뒤 웹이 { agree: true, copyTermsVersion } 만 보낸다)
  if (b.agree === true) {
    if (b.copyTermsVersion !== COPY_TERMS_VERSION) throw badRequest('특약을 끝까지 읽고 동의해야 해요', 'TERMS_OUTDATED');
    await reagreeFollow(db, cur.id, COPY_TERMS_VERSION);
    if (Object.keys(b).every((k) => k === 'agree' || k === 'copyTermsVersion')) return c.json({ ok: true, settings: cur.settings, reagreed: true });
  }
  const next = parseFollowSettings(b, cur.settings, true);
  requireBasics(ctx);
  if (next.copyAmount > cur.settings.copyAmount) {
    const available = await availableOf(c.env, ctx);
    if (next.copyAmount > available) throw badRequest(`따라갈 돈이 지금 쓸 수 있는 돈(${r2(available)} USDT)보다 많아요`, 'INSUFFICIENT');
  }
  await updateFollowSettings(db, cur.id, next);
  return c.json({ ok: true, settings: next });
});

/** 따라하기 멈추기. closePositions 면 장부 포지션 전량 정리(실행 DO, 최선 노력) */
copyRoutes.post('/unfollow', async (c) => {
  const ctx = c.get('ctx');
  const db = c.env.DB;
  const b = await readJson(c);
  const cur = await getActiveFollow(db, ctx.user.id);
  if (!cur) throw new HttpError(404, '따라가는 중이 아니에요', 'NOT_FOLLOWING');
  await stopFollow(db, cur.id, 'user');
  log.info('copy follow stopped by user', { userId: ctx.user.id, followId: cur.id, closePositions: b.closePositions === true });
  // 정리하지 않고 멈추면(또는 정리가 끝나면) 장부는 지운다 — 남은 포지션은 그때부터 사용자 본인 것. 남은 장부는 "정리하지 못한 포지션" 으로 남겨 화면에 알린다 (D1 0024)
  const leave = async () => {
    const rows = await snapshotLeftovers(db, cur, 'user').catch(() => [] as CopyPositionRow[]);
    if (rows.length) background(c, notifyLeftovers(c.env, cur, 'user', rows));
    await deleteCopyPositions(db, ctx.user.id);
    return rows.length;
  };
  if (b.closePositions !== true) { const leftovers = await leave(); return c.json({ ok: true, closed: false, leftovers }); }
  const r = await callDo(copyStub(c.env), 'https://copy/follower/close', { followerId: ctx.user.id });
  const leftovers = await leave();   // 정리에 실패한 종목만 장부에 남아 있다
  if (!r.ok) {
    log.warn('copy follower close unavailable', { userId: ctx.user.id, status: r.status });
    return c.json({ ok: true, closed: false, leftovers, note: '따라하기는 멈췄지만 포지션 정리는 되지 않았어요. 열린 포지션은 직접 정리해 주세요' });
  }
  return c.json({ ok: true, closed: true, leftovers, result: r.data });
});

/** 정리하지 못한 포지션 확인 — 화면에서 지운다 (포지션 자체는 사용자가 직접 정리) */
copyRoutes.post('/leftovers/ack', async (c) => {
  const acked = await ackLeftovers(c.env.DB, c.get('ctx').user.id);
  return c.json({ ok: true, acked });
});

/** 내 실행 내역 50건 (+ 흐름별 실현손익) */
copyRoutes.get('/executions', async (c) => {
  const ctx = c.get('ctx');
  const [execs, pnl] = await Promise.all([listMyCopyExecutions(c.env.DB, ctx.user.id, 50), executionPnl(c.env, ctx)]);
  for (const e of execs) { const m = e.orderId ? pnl.get(e.orderId) : undefined; if (m) e.pnl = m.pnl; }
  return c.json({ executions: execs as CopyExecution[] });
});

// ---------- 관리자 ----------
export const adminCopyRoutes = new Hono<AppEnv>();
adminCopyRoutes.use('*', authMiddleware, async (c, next) => {
  if (!isAdmin(c.env, c.get('ctx').user.loginId)) throw new HttpError(403, '관리자만 볼 수 있어요', 'FORBIDDEN');
  await next();
});

adminCopyRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const [masters, counts, follows, events, pausedGlobal, leftoverCounts] = await Promise.all([listMastersAdmin(db), followerCounts(db), listFollowsAdmin(db), listRecentEvents(db, 50), isPausedGlobal(db), countLeftoversByFollow(db).catch(() => new Map<number, number>())]);
  const toAdmin = (m: (typeof masters)[number]): AdminCopyMaster => ({ userId: m.userId, loginId: m.loginId, nickname: m.nickname, intro: m.intro, status: m.status, appliedAt: m.appliedAt, decidedAt: m.decidedAt, note: m.note, mode: m.mode, hasApiKey: m.hasApiKey, followers: counts.get(m.userId) ?? 0, paused: m.paused });
  const pick = (s: CopyMasterStatus) => masters.filter((m) => m.status === s).map(toAdmin);
  const res: AdminCopyResponse = {
    pending: pick('pending'), approved: pick('approved'), suspended: pick('suspended'), rejected: pick('rejected'),
    follows: follows.map((f): AdminCopyFollow => ({ id: f.id, followerLoginId: f.followerLoginId, masterNickname: f.masterNickname, status: f.status, mode: f.mode, copyAmount: f.settings.copyAmount, copyAmountNow: f.copyAmountNow, realizedPnl: r2(f.realizedPnl), startedAt: f.startedAt, stoppedAt: f.stoppedAt, stopReason: f.stopReason, ...(leftoverCounts.get(f.id) ? { leftovers: leftoverCounts.get(f.id) } : {}) })),
    events,
    pausedGlobal,
  };
  return c.json(res);
});

/** 킬 스위치(전체): 모든 고수의 새 진입(open/add)을 멈춘다. 정리·손절·배율·손실 한도·감시는 계속, 팔로우도 그대로 */
adminCopyRoutes.post('/pause', async (c) => {
  const b = await readJson(c);
  if (typeof b.global !== 'boolean') throw badRequest('global 은 true | false', 'BAD_PAUSE');
  const by = c.get('ctx').user.loginId;
  await setCopyFlag(c.env.DB, PAUSED_GLOBAL_KEY, b.global ? '1' : '0', by);
  log.warn('copy entry pause (global) set', { paused: b.global, by });
  return c.json({ ok: true, pausedGlobal: b.global });
});

/** 킬 스위치(고수별): 이 고수의 새 진입만 멈춘다 */
adminCopyRoutes.post('/masters/:userId/pause', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  if (typeof b.paused !== 'boolean') throw badRequest('paused 는 true | false', 'BAD_PAUSE');
  if (!(await setMasterPaused(c.env.DB, userId, b.paused))) throw new HttpError(404, '고수가 아니에요', 'NOT_MASTER');
  log.warn('copy entry pause (master) set', { userId, paused: b.paused, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, userId, paused: b.paused });
});

/** 고수 승인/거절/중지. 승인 → 감시 DO 깨움. 중지·거절 → 팔로우 전부 정지(포지션은 남김) + DO 멈춤 */
adminCopyRoutes.post('/masters/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  const status: Exclude<CopyMasterStatus, 'none'> | null = b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : b.action === 'suspend' ? 'suspended' : null;
  if (!status) throw badRequest('approve | reject | suspend', 'BAD_ACTION');
  const target = await findUserById(c.env.DB, userId);
  if (!target || target.deleted_at) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  const by = c.get('ctx').user.loginId;
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : null;
  if (!(await setMasterStatus(c.env.DB, userId, status, by, note))) throw new HttpError(409, status === 'approved' ? '신청(대기) 또는 중지 상태에서만 승인할 수 있어요' : status === 'rejected' ? '신청(대기) 상태에서만 거절할 수 있어요' : '이미 그 상태예요', 'BAD_TRANSITION');
  let stoppedFollows = 0;
  if (status === 'approved') {
    await clearMasterState(c.env.DB, userId);   // 재승인: 첫 폴링이 기준선만 다시 잡는다 (중지 동안의 변화를 이벤트로 내지 않게)
    const r = await callDo(masterStub(c.env, userId), 'https://master/kick');
    if (!r.ok) log.warn('copy master kick unavailable', { userId, status: r.status });
  } else {
    stoppedFollows = await stopFollowsOfMaster(c.env.DB, userId, 'master_suspended');
    await callDo(masterStub(c.env, userId), 'https://master/stop');
  }
  log.info('copy master status set', { userId, status, by, stoppedFollows });
  return c.json({ ok: true, status, stoppedFollows });
});

adminCopyRoutes.post('/follows/:id/stop', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw badRequest('팔로우 번호가 올바르지 않아요', 'BAD_ID');
  const f = await getFollow(c.env.DB, id);
  if (!f) throw new HttpError(404, '팔로우가 없어요', 'NO_FOLLOW');
  const stopped = await stopFollow(c.env.DB, id, 'admin');
  let leftovers = 0;
  if (stopped) {
    // 정리 없이 멈춤 → 장부를 "정리하지 못한 포지션" 으로 남기고(사용자 화면 + 관리자 알림) 지운다
    const rows = await snapshotLeftovers(c.env.DB, f, 'admin').catch(() => [] as CopyPositionRow[]);
    leftovers = rows.length;
    if (rows.length) background(c, notifyLeftovers(c.env, f, 'admin', rows));
    await deleteCopyPositions(c.env.DB, f.followerId);
    log.info('copy follow stopped by admin', { followId: id, followerId: f.followerId, by: c.get('ctx').user.loginId, leftovers });
  }
  return c.json({ ok: true, stopped, leftovers });
});

/** 이벤트 재확인: 실패·미확인 실거래 팔로워의 실제 체결을 거래소 주문 조회로 찾아 장부에 올리고 고수의 현재 손절·익절을 맞춘다 (새 주문 없음) */
adminCopyRoutes.post('/events/:id/reconcile', async (c) => {
  const id = c.req.param('id');
  if (!/^copy-\d+-[A-Z]+-\d+$/.test(id)) throw badRequest('이벤트 id 형식 오류', 'BAD_ID');
  const r = await callDo(copyStub(c.env), 'https://copy/reconcile-event', { eventId: id });
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, String(r.data.error ?? '재확인 실패'), 'RECONCILE_FAILED');
  log.info('copy event reconciled by admin', { eventId: id, by: c.get('ctx').user.loginId, results: r.data.results });
  return c.json(r.data);
});
/** 관리자 진단: 관리자 '본인' 계좌의 배율을 바꿔 본다 (고객 계좌에는 절대 쓰지 않는다). 거래소 거절 사유(코드·원문)를 그대로 돌려줘 40012 같은 코드의 뜻을 확인하는 용도 */
adminCopyRoutes.post('/debug/leverage', async (c) => {
  const ctx = c.get('ctx');
  const b = (await readJson(c)) as { symbol?: string; leverage?: number };
  const symbol = String(b.symbol ?? '') as Symbol;
  const lev = Number(b.leverage);
  if (!(lev >= 1 && lev <= 200) || !symbol) throw badRequest('symbol·leverage 필요', 'BAD_REQUEST');
  if (ctx.settings.mode !== 'live') throw badRequest('실거래 모드에서만', 'NO_ADAPTER');
  const adapter = adapterFor(ctx, new PaperClient(c.env));
  const t0 = Date.now();
  try { await adapter.setLeverage(symbol, lev); return c.json({ ok: true, ms: Date.now() - t0 }); }
  catch (e) {
    const w = e as { code?: unknown; httpStatus?: number; message?: string; trace?: unknown };
    log.warn('admin leverage debug refused', { by: ctx.user.loginId, symbol, lev, code: w.code, message: w.message });
    return c.json({ ok: false, code: w.code ?? null, httpStatus: w.httpStatus ?? null, message: w.message ?? String(e), ms: Date.now() - t0 });
  }
});
/** 관리자 진단(읽기 전용): 사용자의 거래소 포지션 원문 — 마진 모드(open_type)·배율·수량. 배율 변경 거절(40012) 원인 확인용. 주문·변경은 하지 않는다 */
adminCopyRoutes.get('/debug/positions/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const creds = await getCredsForUser(c.env, userId);
  if (!creds) throw new HttpError(404, 'API 키 없음', 'NO_API_KEY');
  const client = new WooxClient({ credentials: creds, gate: makeRateGate(c.env) });
  const rows = await client.getPositionsV2();
  const view = rows.map((r) => { const x = r as unknown as Record<string, unknown>; return { symbol: x.symbol, open_type: x.open_type, leverage: x.leverage, position_amount: x.position_amount ?? x.current_amount, position_type: x.position_type, position_side: x.position_side, position_mode: x.position_mode, entry: x.entry_price ?? x.open_avg_price }; });
  log.info('admin positions debug', { by: c.get('ctx').user.loginId, userId, n: view.length });
  return c.json({ userId, positions: view });
});
/** 관리자 진단(읽기 전용): 사용자의 최근 주문·체결 원문(체결가·수수료·실현손익) — 기록된 손익을 실제 체결과 대조할 때. 주문·변경은 하지 않는다 */
adminCopyRoutes.get('/debug/fills/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const symbol = String(c.req.query('symbol') ?? 'BTCUSDT');
  const minutes = Math.min(24 * 60, Math.max(1, Number(c.req.query('minutes')) || 60));
  const creds = await getCredsForUser(c.env, userId);
  if (!creds) throw new HttpError(404, 'API 키 없음', 'NO_API_KEY');
  const client = new WooxClient({ credentials: creds, gate: makeRateGate(c.env) });
  const endSec = Math.floor(Date.now() / 1000);
  const [orders, trades] = await Promise.all([client.getOrderHistory(symbol, endSec - minutes * 60, endSec), client.getTrades(symbol, endSec - minutes * 60, endSec)]);
  log.info('admin fills debug', { by: c.get('ctx').user.loginId, userId, symbol, orders: orders.length, trades: trades.length });
  return c.json({
    userId, symbol,
    orders: orders.map((o) => ({ order_id: o.order_id, client_order_id: o.client_order_id ?? null, side: o.side, type: o.type, size: o.size, deal_size: o.deal_size, deal_avg_price: o.deal_avg_price, state: o.state, create_time: o.create_time, update_time: o.update_time })),
    trades: trades.map((t) => ({ order_id: t.order_id, side: t.side, price: t.price, vol: t.vol, exec_type: t.exec_type, realised_profit: t.realised_profit, paid_fees: t.paid_fees, create_time: t.create_time })),
  });
});
/** 관리자 진단(읽기 전용): 관리자 본인 키로 자주 쓰는 사설 엔드포인트를 1회씩 호출해 거래소 요청 한도 헤더(x-bm-ratelimit-*)를 돌려준다 */
adminCopyRoutes.get('/debug/ratelimit', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx.creds) throw new HttpError(404, 'API 키 없음', 'NO_API_KEY');
  const client = new WooxClient({ credentials: ctx.creds, gate: makeRateGate(c.env) });
  const out: Record<string, unknown> = {};
  const t = async (name: string, fn: () => Promise<unknown>) => { const t0 = Date.now(); try { await fn(); out[name] = { ok: true, ms: Date.now() - t0 }; } catch (e) { out[name] = { ok: false, ms: Date.now() - t0, message: (e as Error).message }; } };
  await t('assets', () => client.getAssets());
  await t('positions', () => client.getPositionsV2());
  await t('plans', () => client.getCurrentPlanOrdersStrict('BTCUSDT'));
  await t('orderHistory', () => client.getOrderHistory('BTCUSDT', Math.floor(Date.now() / 1000) - 120, Math.floor(Date.now() / 1000)));
  await t('contracts', () => client.getContractDetails());
  return c.json({ calls: out, rateLimit: Object.fromEntries(client.lastRateLimit) });
});
/** 관리자 진단: 거래소 요청 관문의 버킷별 현재 사용량/한도 */
adminCopyRoutes.get('/debug/rategate', async (c) => {
  if (!c.env.RATE) return c.json({ enabled: false });
  const r = await c.env.RATE.get(c.env.RATE.idFromName('global')).fetch('https://rate/status');
  return c.json({ enabled: true, buckets: await r.json() });
});
/** 초과 물량 줄이기: 정리 실패로 팔로워에게 쌓인 물량을 고수의 마지막 전량 정리 이후 따라 들어간 수량까지 정리 (관리자 수동 실행) */
adminCopyRoutes.post('/masters/:userId/trim-excess', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const r = await callDo(copyStub(c.env), 'https://copy/trim-excess', { masterId: userId });
  if (!r.ok) throw new HttpError(502, String(r.data.error ?? '실행 실패'), 'TRIM_FAILED');
  log.warn('copy trim-excess by admin', { masterId: userId, by: c.get('ctx').user.loginId, results: r.data.results });
  return c.json(r.data);
});
adminCopyRoutes.post('/masters/:userId/kick', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const r = await callDo(masterStub(c.env, userId), 'https://master/kick');
  return c.json({ ok: r.ok, status: r.status, result: r.data });
});

/** 관리자 전용: 고수 통계 지표별 초기화 (수익률 / 승률·거래 수 / 최근 마감 거래 / 전부). 기준 시각을 지금으로 올리고 바로 다시 계산 */
adminCopyRoutes.post('/masters/:userId/reset-stats', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  const which = b.which;
  if (which !== 'roi' && which !== 'winRate' && which !== 'recent' && which !== 'all') throw badRequest('which 는 roi | winRate | recent | all', 'BAD_WHICH');
  if (!(await getMaster(c.env.DB, userId))) throw new HttpError(404, '고수가 아니에요', 'NOT_MASTER');
  await resetMasterStats(c.env.DB, userId, which);
  log.info('copy master stats reset', { userId, which, by: c.get('ctx').user.loginId });
  const stats = await refreshMasterStats(c.env, userId, true);
  return c.json({ ok: true, which, stats });
});

adminCopyRoutes.get('/masters/:userId/status', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const [r, meta, master] = await Promise.all([callDoGet(masterStub(c.env, userId), 'https://master/status'), getMasterMeta(c.env.DB, userId), getMaster(c.env.DB, userId)]);
  return c.json({ userId, masterStatus: master?.status ?? 'none', available: r.ok, watcher: r.ok ? r.data : null, meta });
});
