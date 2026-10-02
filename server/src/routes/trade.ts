// 사용자 컨텍스트가 필요한 거래 경로: state, order/open, position/close, position/tpsl, settings, paper/reset
import { Hono } from 'hono';
import { calcContracts, SYMBOLS, TERMS_VERSION, type AppState, type ContractInfo, type OpenOrderResult, type Position, type Price, type Symbol, type TradeHistoryItem, type TradeHistoryResponse, type Wallet } from '@easy-futures/shared';
import { PaperAdapter } from '../adapters/paper.js';
import type { BrokerAdapter } from '../adapters/types.js';
import { WooxAdapter } from '../adapters/woox.js';
import { authMiddleware, type AppEnv } from '../auth.js';
import { saveSettings, type UserContext } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { readJson } from '../http.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { disableAuto, loadAutoTags } from '../auto/db.js';
import { copyBadgesOf, getMaster, loadCopyTags, setMasterStatus, stopFollowsOfMaster, stopFollowsOfUser } from '../copy/db.js';
import { masterStub } from '../copy/MasterWatcher.js';
import { dailyPnl, enrichHistory, summarize, summarizeBySource } from '../history.js';
import { PAPER_DISABLED_MSG, parseClientOrderId, parseSymbol, validateOpenOrder, validateSettings, validateTpSl } from '../validate.js';
import { paperAllowed } from './auth.js';
import { WooxClient, WooxError } from '../woox/client.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';

const PRICE_FRESH_MS = 30_000;
/** 주문 검증에 쓸 시세의 최대 나이. 피드가 죽은 채 몇 시간 전 가격으로 검증하지 않게 (감사 B14) */
const ORDER_PRICE_MAX_AGE_MS = 60_000;
const KEY_DECRYPT_FAILED_MSG = '거래소 키를 읽을 수 없어요. 관리자에게 알려 주세요';
const EMPTY_PRICE: Price = { last: 0, mark: 0, updatedAt: 0 };
const EMPTY_WALLET: Wallet = { currency: 'USDT', available: 0, equity: 0, unrealized: 0, positionMargin: 0 };

/** 실거래인데 아직 신분증 승인·API 키가 없으면 무엇이 빠졌는지. 다 갖췄으면(또는 연습 모드면) undefined */
export function needsSetupOf(ctx: UserContext): AppState['needsSetup'] {
  if (ctx.settings.mode !== 'live') return undefined;
  const kyc = ctx.user.kycStatus !== 'approved';
  const apiKey = !ctx.creds && !ctx.credsDecryptFailed;   // 키가 있는데 못 읽는 건 "없음"이 아니다 (감사 B5) → exchangeError 로 따로 알린다
  return kyc || apiKey ? { kyc, apiKey } : undefined;
}

export function adapterFor(ctx: UserContext, paper: PaperClient): BrokerAdapter {
  if (ctx.settings.mode === 'live') {
    if (!ctx.creds && ctx.credsDecryptFailed) throw new HttpError(503, KEY_DECRYPT_FAILED_MSG, 'KEY_DECRYPT_FAILED');
    if (!ctx.creds) throw badRequest('실거래를 하려면 먼저 API 키를 등록해 주세요', 'NO_API_KEY');
    if (ctx.user.kycStatus !== 'approved') throw new HttpError(403, '신분증 인증이 끝나야 실거래를 할 수 있어요', 'KYC_REQUIRED');
    return new WooxAdapter(new WooxClient({ credentials: ctx.creds, gate: ctx.env ? makeRateGate(ctx.env) : null }));
  }
  return new PaperAdapter(paper, ctx.user.id);
}

export const COPY_SYMBOL_LOCKED_MSG = '이 종목은 고수 따라하기로 들어간 포지션이 있어요. 직접 주문하면 손절이 겹칩니다 — 따라하기를 멈추거나 다른 종목을 이용해 주세요';
/**
 * 한 지갑 공유 가드 (2026-09-22): 따라하기가 켜져 있고 그 고수를 따라 들어간 장부 포지션이 같은 종목에 있으면 직접 주문(진입·정리·손절 변경)을 409 로 막는다.
 * 웹이 확인 창을 거쳐 body.force === true 로 다시 보내면 통과. 장부 조회는 3초 캐시 (copyBadgesOf) — 주문 경로는 캐시를 건너뛰고 방금 값을 본다
 */
export async function assertNotCopyLocked(db: D1Database, userId: number, symbol: Symbol, body: Record<string, unknown>): Promise<void> {
  if (body.force === true) return;
  const badge = await copyBadgesOf(db, userId, true).catch(() => null);
  if (!badge || !badge.symbols.includes(symbol)) return;
  throw new HttpError(409, COPY_SYMBOL_LOCKED_MSG, 'COPY_SYMBOL_LOCKED', { symbol, masterNickname: badge.masterNickname });
}
/** 포지션에 고수 따라하기 배지 (`copy.masterNickname`) — 팔로우 중이고 장부에 있는 종목만. 조회 실패는 무시 (화면은 떠야 한다) */
async function withCopyBadges(db: D1Database, userId: number, positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;
  const badge = await copyBadgesOf(db, userId).catch(() => null);
  if (!badge || badge.symbols.length === 0) return positions;
  return positions.map((p) => (badge.symbols.includes(p.symbol) ? { ...p, copy: { masterNickname: badge.masterNickname } } : p));
}

function fillPrices(p: Partial<Record<Symbol, Price>>): Record<Symbol, Price> {
  const out = {} as Record<Symbol, Price>;
  for (const s of SYMBOLS) out[s] = p[s] ?? EMPTY_PRICE;
  return out;
}

export const tradeRoutes = new Hono<AppEnv>();
tradeRoutes.use('*', authMiddleware, async (c, next) => {
  const u = c.get('ctx').user;
  if (u.mustChangePw) throw new HttpError(403, '먼저 새 비밀번호를 정해 주세요', 'MUST_CHANGE_PASSWORD');
  if (u.termsVersion !== TERMS_VERSION) throw new HttpError(403, '바뀐 이용약관에 동의해야 계속 쓸 수 있어요', 'TERMS_OUTDATED');
  await next();
});

tradeRoutes.get('/state', async (c) => {
  const ctx = c.get('ctx');
  const paper = new PaperClient(c.env);
  const now = Date.now();
  let rawPrices: Partial<Record<Symbol, Price>>;
  let wallet: Wallet;
  let positions: Position[];
  if (ctx.settings.mode === 'paper') {
    // 연습 모드: DO 1회 호출로 지갑·포지션·시세를 한 번에 (왕복 최소화)
    const [contracts, s] = await Promise.all([getContracts(), paper.state(ctx.user.id, true)]);
    rawPrices = s.prices; wallet = s.wallet; positions = await withCopyBadges(c.env.DB, ctx.user.id, s.positions);
    return c.json(buildState(ctx, contracts, rawPrices, wallet, positions, now));
  }
  // 실거래: 시세 DO 가 죽어도(3초 타임아웃) 화면은 살아야 한다 → REST 지수가 폴백, 그것도 안 되면 빈 시세 + priceError (감사 B6)
  const [contracts, priced] = await Promise.all([getContracts(), livePrices(paper)]);
  const { priceError } = priced;
  rawPrices = priced.prices;
  // 실거래인데 신분증·API 키가 아직 없음: 오류 대신 빈 지갑 + needsSetup (웹이 안내 카드를 띄운다). 시세는 그대로 준다
  const needsSetup = needsSetupOf(ctx);
  if (needsSetup) return c.json(buildState(ctx, contracts, rawPrices, EMPTY_WALLET, [], now, { needsSetup, priceError }));
  // 키 행은 있는데 복호화 실패: "키 없음" 카드가 아니라 관리자 확인 안내 (감사 B5)
  if (!ctx.creds && ctx.credsDecryptFailed) return c.json(buildState(ctx, contracts, rawPrices, EMPTY_WALLET, [], now, { exchangeError: KEY_DECRYPT_FAILED_MSG, priceError }));
  // 거래소 조회 실패 1회로 3초마다 502 를 내면 시세도 못 본다 → 200 + connected:false + exchangeError (감사 B13). 우리 코드의 HttpError 는 그대로 던진다
  try {
    // 거래소 키별 한도(position-v2 6회/2초)를 폰 앱 폴링이 갉아먹지 않게: 사용자별 2.5초 캐시 (기기·탭이 여럿이어도 거래소에는 한 번)
    const acc = await cachedAccount(ctx.user.id, () => adapterFor(ctx, paper).getAccount(contracts, rawPrices));
    return c.json(buildState(ctx, contracts, rawPrices, acc.wallet, await withCopyBadges(c.env.DB, ctx.user.id, acc.positions), now, { priceError }));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const exchangeError = exchangeErrorMessage(e);
    log.warn('state: exchange query failed', { userId: ctx.user.id, exchangeError, message: (e as Error).message, http: e instanceof WooxError ? e.httpStatus : undefined });
    return c.json(buildState(ctx, contracts, rawPrices, EMPTY_WALLET, [], now, { exchangeError, priceError }));
  }
});

/** 거래소 오류 → 사용자 문장 (감사 B13) */
function exchangeErrorMessage(e: unknown): string {
  const http = e instanceof WooxError ? e.httpStatus : 0;
  if (http === 401 || http === 403) return '거래소 키가 거절됐어요 (키를 다시 등록해 주세요)';
  if (http === 429) return '거래소가 잠시 바빠요';
  return '거래소 연결 실패';
}

/**
 * 실거래용 시세: 시세 DO → 실패하면 거래소 공개 REST 의 지수 가격(index_price) → 그것도 실패하면 빈 시세 + priceError.
 * REST 폴백은 updatedAt=지금 으로 표시한다 (그 순간 받은 값이므로)
 */
async function livePrices(paper: PaperClient): Promise<{ prices: Partial<Record<Symbol, Price>>; priceError?: string }> {
  try {
    return { prices: (await paper.prices()).prices };
  } catch (e) {
    log.warn('price engine failed, falling back to REST index price', { message: (e as Error).message });
  }
  try {
    const list = await new WooxClient({ timeoutMs: 5000 }).getContractDetails();
    const now = Date.now();
    const prices: Partial<Record<Symbol, Price>> = {};
    for (const d of list) {
      if (!(SYMBOLS as string[]).includes(d.symbol)) continue;
      const idx = Number(d.index_price);
      if (idx > 0) prices[d.symbol as Symbol] = { last: idx, mark: idx, updatedAt: now };
    }
    if (SYMBOLS.some((s) => prices[s])) return { prices };
  } catch (e) {
    log.warn('REST price fallback failed', { message: (e as Error).message });
  }
  return { prices: {}, priceError: '시세 지연' };
}

interface StateExtra { needsSetup?: AppState['needsSetup']; exchangeError?: string; priceError?: string }
function buildState(ctx: UserContext, contracts: Record<Symbol, ContractInfo>, raw: Partial<Record<Symbol, Price>>, wallet: Wallet, positions: Position[], now: number, extra: StateExtra = {}): AppState {
  const prices = fillPrices(raw);
  const { needsSetup, exchangeError, priceError } = extra;
  // connected = 거래소/시세 연결. 아직 키가 없거나 거래소 조회가 실패했으면 false (시세 자체는 prices 에 있다)
  const connected = !needsSetup && !exchangeError && SYMBOLS.every((s) => prices[s].last > 0 && now - prices[s].updatedAt < PRICE_FRESH_MS);
  return {
    mode: ctx.settings.mode, connected, wallet, positions, contracts, prices, settings: ctx.settings, serverTime: now,
    ...(needsSetup ? { needsSetup } : {}), ...(exchangeError ? { exchangeError } : {}), ...(priceError ? { priceError } : {}),
  };
}

tradeRoutes.post('/order/open', async (c) => {
  const ctx = c.get('ctx');
  const paper = new PaperClient(c.env);
  const body = await readJson(c);
  const symbol = parseSymbol(body.symbol);
  await assertNotCopyLocked(c.env.DB, ctx.user.id, symbol, body);
  const clientOrder = parseClientOrderId(body.clientOrderId);
  const [contracts, pr] = await Promise.all([getContracts(), paper.prices()]);
  const price = pr.prices[symbol]?.mark || pr.prices[symbol]?.last || 0; // 마크가 기준 (last는 비정상 체결 가능)
  if (price > 0 && Date.now() - (pr.prices[symbol]?.updatedAt ?? 0) > ORDER_PRICE_MAX_AGE_MS) throw badRequest('시세가 오래돼 주문할 수 없어요. 잠시 후 다시', 'PRICE_STALE');
  const req = validateOpenOrder(body, ctx.settings, price);
  const contract = contracts[symbol];
  const n = calcContracts(req.amountUsdt, req.leverage, price, contract);
  if (n <= 0) throw badRequest('금액이 너무 적어요', 'TOO_SMALL');
  const adapter = adapterFor(ctx, paper);
  // 같은 표식으로 이미 낸 주문이 있으면(웹 15초 타임아웃 뒤 재시도) 다시 내지 않고 그 결과만 돌려준다 (감사 B2). 웹이 표식을 보냈을 때만 조회 1회
  if (clientOrder.supplied && adapter instanceof WooxAdapter) {
    const prior = await adapter.findOrderByClientId(symbol, clientOrder.id);
    if (prior) {
      log.info('duplicate order attempt answered from history', { userId: ctx.user.id, symbol, clientOrderId: clientOrder.id, orderId: prior.orderId, dealSize: prior.dealSize });
      if (!(prior.dealSize > 0)) throw new HttpError(409, '아까 낸 주문은 체결되지 않았어요. 잠시 후 다시 시도해 주세요', 'NO_FILL', { orderId: prior.orderId, duplicate: true });
      const dup: OpenOrderResult & { duplicate: true } = {
        orderId: prior.orderId, contracts: prior.dealSize, coinAmount: prior.dealSize * contract.contractSize,
        entryPrice: prior.dealAvgPrice, fillPrice: prior.dealAvgPrice, stopLossPrice: req.stopLossPrice, takeProfitPrice: req.takeProfitPrice ?? null, adjusted: false, duplicate: true,
      };
      return c.json(dup);
    }
  }
  const result = await adapter.openOrder(req, n, contract, price, { clientOrderId: clientOrder.id });
  return c.json(result);
});

tradeRoutes.post('/position/close', async (c) => {
  const ctx = c.get('ctx');
  const paper = new PaperClient(c.env);
  const body = await readJson(c);
  const symbol = parseSymbol(body.symbol);
  await assertNotCopyLocked(c.env.DB, ctx.user.id, symbol, body);
  const contracts = await getContracts();
  await adapterFor(ctx, paper).closePosition(symbol, contracts[symbol]);
  return c.json({ ok: true });
});

tradeRoutes.post('/position/tpsl', async (c) => {
  const ctx = c.get('ctx');
  const paper = new PaperClient(c.env);
  const body = await readJson(c);
  const symbol = parseSymbol(body.symbol);
  await assertNotCopyLocked(c.env.DB, ctx.user.id, symbol, body);
  const adapter = adapterFor(ctx, paper);
  const [contracts, pr, direction] = await Promise.all([getContracts(), paper.prices(), adapter.getPositionDirection(symbol)]);
  if (!direction) throw new HttpError(404, '포지션이 없어요', 'NO_POSITION');
  const req = validateTpSl(body, direction, pr.prices[symbol]?.mark || pr.prices[symbol]?.last || 0);
  await adapter.updateTpSl(req, contracts[symbol]);
  return c.json({ ok: true });
});

/** 사용자별 계좌 조회 캐시 — 2.5초 안의 재요청은 같은 결과(진행 중이면 같은 Promise). 실패는 캐시하지 않는다 */
const ACCOUNT_TTL_MS = 2_500;
const accountCache = new Map<number, { at: number; value: Promise<Awaited<ReturnType<BrokerAdapter['getAccount']>>> }>();
function cachedAccount(userId: number, fn: () => Promise<Awaited<ReturnType<BrokerAdapter['getAccount']>>>): Promise<Awaited<ReturnType<BrokerAdapter['getAccount']>>> {
  const hit = accountCache.get(userId);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.value;
  const value = fn().catch((e) => { accountCache.delete(userId); throw e; });
  accountCache.set(userId, { at: Date.now(), value });
  if (accountCache.size > 1000) for (const [k, v] of accountCache) if (Date.now() - v.at > ACCOUNT_TTL_MS) accountCache.delete(k);
  return value;
}

tradeRoutes.get('/history', async (c) => {
  const ctx = c.get('ctx');
  const paper = new PaperClient(c.env);
  const daysRaw = Number(c.req.query('days') ?? 30);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
  if (needsSetupOf(ctx)) { const empty: TradeHistoryResponse = { items: [], days, realizedPnl: 0, totalFees: 0, netPnl: 0, closedCount: 0, bySource: { auto: summarize([]), manual: summarize([]) }, daily: [] }; return c.json(empty); }
  const key = `${ctx.user.id}:${ctx.settings.mode}:${days}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return c.json(await hit.value);
  const value = (async () => {
    const contracts = await getContracts();
    const [raw, tags, copyTags] = await Promise.all([adapterFor(ctx, paper).getHistory(days, contracts), loadAutoTags(c.env.DB, ctx.user.id), loadCopyTags(c.env.DB, ctx.user.id)]);
    const items = enrichHistory(raw, tags, copyTags);
    const total = summarize(items);
    const res: TradeHistoryResponse = { items: items.slice(0, 300), days, ...total, bySource: summarizeBySource(items), daily: dailyPnl(items) };
    return res;
  })().catch((e) => { historyCache.delete(key); throw e; });
  historyCache.set(key, { at: Date.now(), value });
  if (historyCache.size > 500) for (const [k, v] of historyCache) if (Date.now() - v.at > HISTORY_TTL_MS) historyCache.delete(k);
  return c.json(await value);
});
// 거래 내역은 거래소 호출(종목당 2건)이라 사용자·기간별 20초 캐시 — 기간 버튼을 오가며 여러 번 눌러도 거래소를 다시 부르지 않는다
const HISTORY_TTL_MS = 20_000;
const historyCache = new Map<string, { at: number; value: Promise<TradeHistoryResponse> }>();

tradeRoutes.get('/settings', (c) => c.json(c.get('ctx').settings));

tradeRoutes.put('/settings', async (c) => {
  const ctx = c.get('ctx');
  const next = validateSettings(await readJson(c), ctx.settings, !!ctx.creds, ctx.user.kycStatus === 'approved', paperAllowed(c.env, ctx.user.loginId));
  await saveSettings(c.env, ctx.user.id, next);
  // 실거래 → 연습 전환: 자동매매가 켜져 있으면 끈다 (신호가 연습 엔진으로 가고 거래소 포지션이 방치되는 것 방지 — 감사 H3)
  const toPaper = ctx.settings.mode === 'live' && next.mode === 'paper';
  const autoDisabled = toPaper ? await disableAuto(c.env.DB, ctx.user.id, '연습 모드로 바꿔서 AI 자동매매를 껐어요. 거래소에 남은 포지션은 직접 확인하세요') : false;
  // 카피 팔로우는 시작한 모드에 묶여 있다 → 어느 쪽으로든 모드가 바뀌면 멈춘다 (실거래 팔로우가 연습 엔진으로, 연습 팔로우가 실계좌로 흘러가지 않게). 포지션은 남긴다 (손절은 걸려 있음)
  const modeChanged = ctx.settings.mode !== next.mode;
  const copyStopped = modeChanged ? await stopFollowsOfUser(c.env.DB, ctx.user.id, 'mode_switch') : false;
  // 승인된 고수가 연습으로 바꾸면 고수 자격 중지 — 연습 계좌의 매매가 실거래 팔로워에게 복제되면 안 된다
  let masterSuspended = false;
  if (toPaper && (await getMaster(c.env.DB, ctx.user.id))?.status === 'approved') {
    masterSuspended = await setMasterStatus(c.env.DB, ctx.user.id, 'suspended', 'system', '연습 모드로 전환');
    await stopFollowsOfMaster(c.env.DB, ctx.user.id, 'master_suspended');
    await masterStub(c.env, ctx.user.id).fetch('https://master/stop', { method: 'POST' }).catch(() => null);
  }
  return c.json({ ...next, ...(autoDisabled ? { autoDisabled: true } : {}), ...(copyStopped ? { copyStopped: true } : {}), ...(masterSuspended ? { masterSuspended: true } : {}) });
});

tradeRoutes.post('/paper/reset', async (c) => {
  const ctx = c.get('ctx');
  if (!paperAllowed(c.env, ctx.user.loginId)) throw badRequest(PAPER_DISABLED_MSG, 'PAPER_DISABLED');
  await new PaperClient(c.env).reset(ctx.user.id);
  return c.json({ ok: true });
});
