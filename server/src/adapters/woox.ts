// 실거래 어댑터: 사용자 키로 만든 WooxClient 로 거래소에 직행. one_way_mode + isolated 가정.
import {
  calcPnl,
  priceAtRoi,
  roundToPrecision,
  type ContractInfo,
  type Direction,
  type OpenOrderRequest,
  type OpenOrderResult,
  type Position,
  type Price,
  type Symbol,
  type TradeHistoryItem,
  type UpdateTpSlRequest,
  type Wallet,
} from '@easy-futures/shared';
import { SYMBOLS } from '@easy-futures/shared';
import { badRequest, HttpError } from '../errors.js';
import { log } from '../log.js';
import { WooxError, type WooxClient, type WooxOrder, type WooxOrderFill, type WooxPlanOrder, type WooxPositionV2 } from '../woox/client.js';
import type { BrokerAdapter, CloseResult, OrderOpts, PositionMode } from './types.js';

/** 주문 뒤 체결 확인 — 주문 1건 조회를 이 간격으로 최대 4번 (합 3.75초). 포지션 목록 10번 폴링은 팬아웃(팔로워 9명)에서 429 를 불렀다 (2026-09-22) */
const FILL_POLL_DELAYS_MS = [250, 500, 1000, 2000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** position-v2 행의 position_mode 로 계정 모드 추정. 행이 없으면 unknown (거래 동작에는 쓰지 않는다 — 표시·진단용) */
export function positionModeOf(rows: WooxPositionV2[]): PositionMode {
  for (const p of rows) {
    const m = String(p.position_mode ?? '').toLowerCase();
    if (m.startsWith('hedge')) return 'hedge';
    if (m.startsWith('one_way')) return 'one_way';
  }
  return 'unknown';
}

// one_way_mode side 코드 (docs/woox-pro-api.md): 1=buy(오른다), 4=sell(내린다), 3=롱 정리, 2=숏 정리
// 유동성 대응(docs/woox-pro-api.md 유동성 절): 호가창이 비어 있어 시장가 대신 "지정가 IOC(마크가 ± 슬리피지 상한)"로 체결 범위를 강제한다.
const OPEN_SLIPPAGE = 0.003;  // 진입: 마크가 대비 0.3% 까지만 허용
const CLOSE_SLIPPAGE = 0.01;  // 정리: 1% 까지 허용 (정리는 반드시 되어야 하므로 더 넓게)
const PRICE_TYPE_FAIR = 2 as const; // TP/SL 트리거는 마크가 기준. last_price(1)는 비정상 체결(644달러)에 반응함
function limitPrice(mark: number, side: 'buy' | 'sell', slip: number, c: ContractInfo): string {
  const p = side === 'buy' ? mark * (1 + slip) : mark * (1 - slip);
  return String(roundToPrecision(p, c.pricePrecision));
}
const CLOSE_SLIPPAGE_TIGHT = 0.002;
/** 정리 지정가: 현재가±slip 을 강제정리 가격 안쪽(0.05% 여유)으로 자른다. 롱 정리=매도(아래로), 숏 정리=매수(위로). 강제정리 가격을 모르면(0) 자르지 않는다 */
export function closeLimitPrice(mark: number, direction: Direction, slip: number, liq: number, c: ContractInfo): string {
  let p = direction === 'long' ? mark * (1 - slip) : mark * (1 + slip);
  if (liq > 0) {
    if (direction === 'long') { const floor = liq * 1.0005; if (floor < mark) p = Math.max(p, floor); }   // 매도가는 강제정리가보다 위
    else { const cap = liq * 0.9995; if (cap > mark) p = Math.min(p, cap); }                                // 매수가는 강제정리가보다 아래
  }
  return String(roundToPrecision(p, c.pricePrecision));
}
const SIDE_OPEN: Record<Direction, number> = { long: 1, short: 4 };
const SIDE_CLOSE: Record<Direction, number> = { long: 3, short: 2 };

const n = (v: unknown, def = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
};

let unknownDirectionLogged = false;
/**
 * position-v2 방향 해석 — 절대 추측하지 않는다. 순서: position_side(long/short) → position_type(1=long,2=short) → 부호 있는 수량 →
 * 미실현 손익 부호 × (마크가 − 평단) 교차 확인. 그래도 모르면 WooxError('UNKNOWN_DIRECTION') (원본 행은 한 번만 로그, 키 없음).
 * 수량이 0 이면 null (포지션 없음).
 * TODO(verify-live): 실계정 1계약으로 어떤 필드가 오는지 확인.
 */
export function positionDirection(p: WooxPositionV2): Direction | null {
  const amount = n(p.position_amount ?? p.current_amount);
  if (amount === 0) return null;
  if (p.position_side === 'long') return 'long';
  if (p.position_side === 'short') return 'short';
  const t = Number(p.position_type);
  if (t === 1) return 'long';
  if (t === 2) return 'short';
  if (amount < 0) return 'short';
  // 부호 없는 수량(양수)은 방향 정보가 아니다 — 손익 부호로 교차 확인
  const pnl = p.unrealized_pnl === undefined || p.unrealized_pnl === null || p.unrealized_pnl === '' ? NaN : Number(p.unrealized_pnl);
  const mark = n(p.mark_price);
  const avg = n(p.open_avg_price ?? p.entry_price);
  if (Number.isFinite(pnl) && pnl !== 0 && mark > 0 && avg > 0 && mark !== avg) {
    const up = mark > avg;
    return (pnl > 0) === up ? 'long' : 'short';
  }
  if (!unknownDirectionLogged) {
    unknownDirectionLogged = true;
    log.error('woox position direction unknown (raw row, once)', { row: p });
  }
  throw new WooxError('포지션 방향을 알 수 없어요 (거래소 응답 형식 확인 필요)', 'UNKNOWN_DIRECTION', 0, '/contract/private/position-v2');
}

export class WooxAdapter implements BrokerAdapter {
  constructor(private readonly client: WooxClient) {}

  private async openPositions(symbol?: Symbol): Promise<WooxPositionV2[]> {
    const list = await this.client.getPositionsV2(symbol);
    return list.filter((p) => Math.abs(n(p.position_amount ?? p.current_amount)) > 0);
  }

  async getAccount(contracts: Record<Symbol, ContractInfo>, prices: Partial<Record<Symbol, Price>>): Promise<{ wallet: Wallet; positions: Position[]; rawPositionCount: number; positionMode: PositionMode }> {
    // 자산 ∥ (포지션 → 종목별 플랜 주문) — 왕복 2회분으로
    const [assets, { rows, plans, rawCount, positionMode }] = await Promise.all([
      this.client.getAssets(),
      this.openPositions().then(async (raw) => {
        const rows = raw.filter((p) => (SYMBOLS as string[]).includes(p.symbol) && positionDirection(p));
        // 플랜 주문 조회 실패는 "손절 없음" 이 아니라 "모름" — null 로 남겨 tpslUnknown 으로 표시한다
        const plans = await Promise.all(rows.map((p) => this.client.getCurrentPlanOrdersStrict(p.symbol).catch((e) => { log.warn('woox.current-plan-order failed (tpsl unknown)', { symbol: p.symbol, message: (e as Error).message }); return null; })));
        // 앱 종목 필터 전 원본 수 — position_deposit 은 계좌 전체(XRP 등 미지원 종목 포함)라 감시자의 VANISHED 판정은 이 값으로 (감사 A2)
        return { rows, plans, rawCount: raw.length, positionMode: positionModeOf(raw) };
      }),
    ]);
    const usdt = assets.find((a) => a.currency === 'USDT');
    const wallet: Wallet = {
      currency: 'USDT',
      available: n(usdt?.available_balance),
      equity: n(usdt?.equity),
      unrealized: n(usdt?.unrealized),
      positionMargin: n(usdt?.position_deposit),
    };
    const positions: Position[] = [];
    for (const [i, p] of rows.entries()) {
      const symbol = p.symbol as Symbol;
      const direction = positionDirection(p)!;
      const c = contracts[symbol];
      const plan = plans[i];
      const size = Math.abs(n(p.position_amount ?? p.current_amount));
      const coinAmount = size * c.contractSize;
      const entry = n(p.open_avg_price ?? p.entry_price);
      const mark = n(p.mark_price) || prices[symbol]?.mark || prices[symbol]?.last || entry;
      const leverage = n(p.leverage, 1);
      const notional = coinAmount * mark;
      const margin = n(p.initial_margin) || (leverage > 0 ? (coinAmount * entry) / leverage : 0);
      const pnl = p.unrealized_pnl !== undefined ? n(p.unrealized_pnl) : calcPnl(entry, mark, coinAmount, direction);
      positions.push({
        symbol,
        direction,
        contracts: size,
        coinAmount,
        entryPrice: entry,
        markPrice: mark,
        leverage,
        marginUsdt: margin,
        notionalUsdt: notional,
        unrealizedPnl: pnl,
        unrealizedPct: margin > 0 ? (pnl / margin) * 100 : 0,
        liquidationPrice: n(p.liquidation_price) || null,
        stopLossPrice: plan ? findPlan(plan, 'stop_loss')?.trigger ?? null : null,
        takeProfitPrice: plan ? findPlan(plan, 'take_profit')?.trigger ?? null : null,
        openedAt: n(p.open_timestamp ?? p.timestamp) || Date.now(),
        ...(plan ? {} : { tpslUnknown: true as const }),
      });
    }
    return { wallet, positions, rawPositionCount: rawCount, positionMode };
  }

  /** 체결(trades) + 주문 이력(type)으로 내역 구성. one_way_mode side: 1=buy(롱 진입) 4=sell(숏 진입) 3=롱 정리 2=숏 정리 */
  async getHistory(days: number, contracts: Record<Symbol, ContractInfo>): Promise<TradeHistoryItem[]> {
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - days * 86_400;
    const out: TradeHistoryItem[] = [];
    await Promise.all(SYMBOLS.map(async (symbol) => {
      const [trades, orders] = await Promise.all([
        this.client.getTrades(symbol, startSec, endSec),
        this.client.getOrderHistory(symbol, startSec, endSec).catch(() => [] as WooxOrder[]),
      ]);
      const orderType = new Map(orders.map((o) => [String(o.order_id), { type: String(o.type ?? ''), leverage: n(o.leverage), clientOrderId: o.client_order_id ? String(o.client_order_id) : null }]));
      for (const t of trades) {
        const side = Number(t.side);
        const isOpen = side === 1 || side === 4;
        const direction: Direction = side === 1 || side === 3 ? 'long' : 'short';
        const meta = orderType.get(String(t.order_id));
        const ot = meta?.type ?? '';
        let kind: TradeHistoryItem['kind'] = isOpen ? 'open' : 'close';
        if (!isOpen && (ot === 'liquidate' || ot === 'bankruptcy' || ot === 'adl')) kind = 'liq';
        else if (!isOpen && (ot === 'planorder' || ot === 'trailing')) kind = 'auto';
        const vol = n(t.vol);
        out.push({
          id: `woox-${t.trade_id}`,
          time: Number(t.create_time),
          symbol,
          kind,
          direction,
          contracts: vol,
          coinAmount: vol * (contracts[symbol]?.contractSize ?? 0),
          price: n(t.price),
          pnl: isOpen ? null : n(t.realised_profit),
          fee: t.paid_fees != null ? Math.abs(n(t.paid_fees)) : null,
          leverage: meta?.leverage || null,
          orderId: String(t.order_id),
          clientOrderId: meta?.clientOrderId ?? null,
        });
      }
    }));
    return out.sort((a, b) => b.time - a.time);
  }

  async getPositionDirection(symbol: Symbol): Promise<Direction | null> {
    const list = await this.openPositions(symbol);
    const p = list.find((x) => x.symbol === symbol);
    return p ? positionDirection(p) : null;
  }

  async openOrder(req: OpenOrderRequest, contracts: number, _contract: ContractInfo, markPrice: number, opts: OrderOpts = {}): Promise<OpenOrderResult> {
    if (!(markPrice > 0)) throw badRequest('지금 가격을 아직 못 받았어요. 잠시 후 다시 해 주세요', 'NO_PRICE');
    const before = (await this.openPositions(req.symbol)).find((x) => x.symbol === req.symbol);
    const existing = before ? positionDirection(before) : null;
    if (existing && existing !== req.direction) throw badRequest('반대 방향 포지션이 있어요. 먼저 정리해 주세요', 'OPPOSITE_POSITION');
    const sizeBefore = before ? Math.abs(n(before.position_amount ?? before.current_amount)) : 0;
    const avgBefore = before ? n(before.open_avg_price ?? before.entry_price) : 0;
    // 이미 같은 방향 포지션이 있으면(불타기) 프리셋 손절/익절을 주문에 붙이지 않는다 — 붙이면 기존 플랜 주문과 별개로
    // 두 번째 손절 주문이 생겨 하나가 발동한 뒤 반대 포지션이 열릴 수 있다. 체결 후 기존 플랜 주문을 새 값으로 수정한다.
    const addingToPosition = sizeBefore > 0;
    try {
      await this.client.submitLeverage(req.symbol, req.leverage, 'isolated');
    } catch (e) {
      // 같은 값으로 재설정 시 거절하는 거래소가 있어 경고만 남기고 진행 (주문에도 leverage 를 함께 보낸다)
      log.warn('submit-leverage failed', { message: (e as Error).message });
    }
    const r = await this.client.submitOrder({
      symbol: req.symbol,
      side: SIDE_OPEN[req.direction],
      type: 'limit',
      price: limitPrice(markPrice, req.direction === 'long' ? 'buy' : 'sell', OPEN_SLIPPAGE, _contract),
      size: contracts,
      leverage: String(req.leverage),
      open_type: 'isolated',
      mode: 3, // IOC: 허용 범위 안에서 즉시 체결되는 만큼만, 나머지는 자동 취소
      ...(opts.clientOrderId ? { client_order_id: opts.clientOrderId } : {}),
      ...(addingToPosition ? {} : {
        preset_stop_loss_price: String(req.stopLossPrice),
        preset_stop_loss_price_type: PRICE_TYPE_FAIR,
        ...(req.takeProfitPrice ? { preset_take_profit_price: String(req.takeProfitPrice), preset_take_profit_price_type: PRICE_TYPE_FAIR } : {}),
      }),
    });
    // 체결 확인: 포지션 수량이 늘어야 체결이다. IOC 가 하나도 안 잡히면(호가 부족) 주문은 자동 취소되고 프리셋도 무효 → 실패로 알린다.
    const orderId = String(r.order_id);
    // 여기부터는 주문이 이미 거래소에 들어간 상태 — 확인 중 오류를 "거절"(502)로 돌려주면 웹이 재시도해 같은 방향으로 두 번 진입한다(감사 B3).
    // 우리가 판정한 HttpError(NO_FILL 등)는 그대로, 그 밖의 오류는 409 ORDER_SENT_UNCONFIRMED 로 구분해 알린다
    try {
    // 1) 주문 1건 조회로 체결 확정 (250ms·500ms·1s·2s, 최대 4번) → 2) 포지션은 한 번만 읽어 늘어난 수량·평단을 만든다.
    //    조회가 안 됐으면(오류·미등록) 예전처럼 포지션 폴링(짧게 3번)으로 판정
    const fill = await this.pollOrderFill(req.symbol, orderId);
    const seen = await this.waitForFill(req.symbol, sizeBefore, fill ? (fill.dealSize > 0 ? 2 : 1) : 3);
    let { size: sizeAfter, avg: avgAfter } = seen;
    let fillPrice: number | null = fill && fill.dealSize > 0 && fill.dealAvgPrice ? fill.dealAvgPrice : null;
    if (!(sizeAfter > sizeBefore)) {
      // 포지션 반영이 늦을 수 있다 → 주문 체결 수량으로 확정 (NO_FILL 오탐 방지). 아직 결론이 없는 주문은 한 번 더 조회, 실패면 폴링 결과를 믿는다
      const f2 = fill && (fill.dealSize > 0 || fill.finished) ? fill
        : await this.client.getOrder(req.symbol, { orderId }).catch((e) => { log.warn('order lookup after no-fill failed', { orderId, message: (e as Error).message }); return null; });
      if (f2 && f2.dealSize > 0) {
        sizeAfter = sizeBefore + f2.dealSize;
        fillPrice = f2.dealAvgPrice;
        log.info('order filled per order lookup (position poll lagged)', { symbol: req.symbol, orderId, dealSize: f2.dealSize });
      } else throw new HttpError(409, '지금은 거래가 뜸해 체결되지 않았어요. 잠시 후 다시 시도해 주세요', 'NO_FILL', { orderId });
    }
    const filledContracts = Math.max(0, Math.round(sizeAfter - sizeBefore));   // 장부 = 실제로 늘어난 계약 수 (요청 수량이 아님)
    if (addingToPosition) {
      // 불타기: 기존 손절/익절 플랜 주문을 새 값으로 수정 (평단 재계산은 아래 align 에서)
      await this.updateTpSl({ symbol: req.symbol, stopLossPrice: req.stopLossPrice, ...(req.takeProfitPrice ? { takeProfitPrice: req.takeProfitPrice } : {}) }, _contract)
        .catch((e) => log.warn('tp/sl update after add failed', { message: (e as Error).message }));
    }
    // 체결 직후 실제 평단을 읽어 손절/익절을 "내 돈 기준 %" 그대로 다시 맞춘다 (고배율에서 체결가 오차 보정). 방금 읽은 포지션 행이 있으면 다시 읽지 않는다
    const fixed = await this.alignTpSlToEntry(req, _contract, seen.size > sizeBefore ? seen.row : undefined).catch((e) => {
      log.warn('tp/sl align failed (presets kept)', { message: (e as Error).message });
      return null;
    });
    const entry = fixed?.entry ?? (avgAfter > 0 ? avgAfter : null);
    // 이번 주문만의 체결가: 신규면 평단 그대로, 불타기면 (평단후×수량후 − 평단전×수량전)/증가분. 이상하면(마크 대비 ±5% 밖) 마크로
    if (fillPrice == null && entry != null && filledContracts > 0) {
      const raw = sizeBefore > 0 && avgBefore > 0 ? (entry * sizeAfter - avgBefore * sizeBefore) / filledContracts : entry;
      fillPrice = Number.isFinite(raw) && raw > 0 && Math.abs(raw - markPrice) / markPrice <= 0.05 ? roundToPrecision(raw, _contract.pricePrecision) : markPrice;
    }
    return {
      orderId,
      contracts: filledContracts,
      coinAmount: filledContracts * _contract.contractSize,
      entryPrice: entry ?? (n(r.price) || null),
      fillPrice,
      stopLossPrice: fixed?.sl ?? req.stopLossPrice,
      takeProfitPrice: fixed?.tp ?? req.takeProfitPrice ?? null,
      adjusted: !!fixed?.adjusted,
    };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log.error('order sent but fill confirmation failed', { symbol: req.symbol, orderId, message: (e as Error).message });
      throw new HttpError(409, '주문은 접수됐지만 체결 확인에 실패했어요. 포지션을 확인한 뒤 다시 시도해 주세요', 'ORDER_SENT_UNCONFIRMED', { orderId });
    }
  }

  /** 같은 표식(client_order_id)으로 이미 낸 주문이 있는지 — 주문 이력 1회 조회 (재시도 중복 진입 방지, 감사 B2). 조회 실패는 WooxError 그대로 */
  findOrderByClientId(symbol: Symbol, clientOrderId: string): Promise<WooxOrderFill | null> {
    return this.client.findOrderByClientId(symbol, clientOrderId);
  }

  /** 429 면 거래소가 알려 준 대기(retryAfterMs, 0.25~10초) 뒤 한 번만 다시 — 팬아웃 중 다른 팔로워의 호출과 겹칠 때. 다른 오류는 그대로 던진다 */
  private async retry429<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof WooxError && e.httpStatus === 429)) throw e;
      const waitMs = Math.min(Math.max(e.retryAfterMs ?? 5000, 250), 10_000);
      log.warn('woox 429 during fill confirmation — retrying once', { path: e.path, waitMs });
      await sleep(waitMs);
      return fn();
    }
  }

  /**
   * 주문 뒤 체결 확인 — 주문 1건 조회(getOrder)를 250ms·500ms·1s·2s 뒤 최대 4번. 체결(deal_size > 0)이나 종료(state 4)가 보이면 바로 멈춘다.
   * 429 는 한 번 재시도, 그 밖의 조회 실패는 마지막으로 본 값(없으면 null) — 호출자가 포지션 읽기로 폴백한다. 주문이 아직 조회에 없으면 다음 간격에 다시
   */
  private async pollOrderFill(symbol: Symbol, orderId: string): Promise<WooxOrderFill | null> {
    let last: WooxOrderFill | null = null;
    for (const delay of FILL_POLL_DELAYS_MS) {
      await sleep(delay);
      try {
        const fill = await this.retry429(() => this.client.getOrder(symbol, { orderId }));
        if (!fill) continue;
        last = fill;
        if (fill.dealSize > 0 || fill.finished) return fill;
      } catch (e) {
        log.warn('order lookup during fill confirmation failed (falling back to position read)', { symbol, orderId, message: (e as Error).message });
        return last;
      }
    }
    return last;
  }

  /** 주문 뒤 포지션 수량이 sizeBefore 보다 커질 때까지 200ms 간격으로 최대 attempts 번 확인. 마지막으로 관측한 수량·평단·행을 돌려준다 (못 늘면 size ≤ sizeBefore) */
  private async waitForFill(symbol: Symbol, sizeBefore: number, attempts = 3): Promise<{ size: number; avg: number; row?: WooxPositionV2 }> {
    let last: { size: number; avg: number; row?: WooxPositionV2 } = { size: sizeBefore, avg: 0 };
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(200);
      const p = (await this.retry429(() => this.openPositions(symbol))).find((x) => x.symbol === symbol);
      if (!p) continue;
      last = { size: Math.abs(n(p.position_amount ?? p.current_amount)), avg: n(p.open_avg_price ?? p.entry_price), row: p };
      if (last.size > sizeBefore) return last;
    }
    return last;
  }

  /** 손절 플랜 주문이 걸려 있는가 (엄격 조회 — 실패하면 던진다). 카피 진입 뒤 확인용 */
  async hasStopLoss(symbol: Symbol): Promise<boolean> {
    const plans = await this.client.getCurrentPlanOrdersStrict(symbol);
    return findPlan(plans, 'stop_loss') != null;
  }

  /** client_order_id 로 체결 수량 확인 (실행기가 죽은 뒤 복구). 주문 조회 → 주문 이력 순. 못 찾으면 null */
  async findFill(symbol: Symbol, clientOrderId: string): Promise<{ dealSize: number; dealAvgPrice: number | null; orderId?: string | null } | null> {
    const direct = await this.client.getOrder(symbol, { clientOrderId }).catch((e) => { log.warn('order lookup by client id failed, trying history', { message: (e as Error).message }); return null; });
    const fill = direct ?? (await this.client.findOrderByClientId(symbol, clientOrderId));
    return fill ? { dealSize: fill.dealSize, dealAvgPrice: fill.dealAvgPrice, orderId: fill.orderId ?? null } : null;
  }

  /** 체결된 포지션의 평단으로 SL/TP 를 재계산해 프리셋과 다르면 수정. 평단을 못 읽으면 null. */
  private async alignTpSlToEntry(req: OpenOrderRequest, contract: ContractInfo, known?: WooxPositionV2): Promise<{ entry: number; sl: number; tp: number | null; adjusted: boolean } | null> {
    // ROI 프리셋이 없어도 체결 평단은 항상 읽는다 (카피 장부의 진입가 = 실제 체결가, 지정가 에코가 아님). 호출자가 방금 읽은 행을 주면 다시 읽지 않는다
    let p: WooxPositionV2 | undefined = known;
    for (let i = 0; i < 3 && !p; i++) {
      if (i > 0) await sleep(200);
      p = (await this.retry429(() => this.openPositions(req.symbol))).find((x) => x.symbol === req.symbol);
    }
    if (!p) return null;
    const entry = n(p.open_avg_price ?? p.entry_price);
    if (!(entry > 0)) return null;
    const lev = n(p.leverage) || req.leverage;
    const sl = req.stopLossRoiPct ? roundToPrecision(priceAtRoi(entry, req.stopLossRoiPct, lev, req.direction, 'sl'), contract.pricePrecision) : req.stopLossPrice;
    const tp = req.takeProfitRoiPct ? roundToPrecision(priceAtRoi(entry, req.takeProfitRoiPct, lev, req.direction, 'tp'), contract.pricePrecision) : (req.takeProfitPrice ?? null);
    const slChanged = Math.abs(sl - req.stopLossPrice) >= contract.pricePrecision;
    const tpChanged = tp != null && (req.takeProfitPrice == null || Math.abs(tp - req.takeProfitPrice) >= contract.pricePrecision);
    if (slChanged || tpChanged) {
      await this.updateTpSl({ symbol: req.symbol, ...(slChanged ? { stopLossPrice: sl } : {}), ...(tpChanged ? { takeProfitPrice: tp } : {}) }, contract);
      log.info('tp/sl aligned to entry', { symbol: req.symbol, entry, sl, tp, presetSl: req.stopLossPrice, presetTp: req.takeProfitPrice ?? null });
    }
    return { entry, sl, tp, adjusted: slChanged || tpChanged };
  }

  async closePosition(symbol: Symbol, contract: ContractInfo, opts: OrderOpts = {}): Promise<CloseResult> {
    return this.closeContracts(symbol, contract, null, opts);
  }

  /** 부분 정리 (카피 트레이딩 reduce): contracts 만큼만. 보유량 이상이면 전량 정리와 같다 */
  async reducePosition(symbol: Symbol, contracts: number, contract: ContractInfo, opts: OrderOpts = {}): Promise<CloseResult> {
    const wanted = Math.floor(contracts);
    if (!(wanted > 0)) throw badRequest('정리할 계약 수가 올바르지 않아요', 'BAD_CONTRACTS');
    return this.closeContracts(symbol, contract, wanted, opts);
  }

  /**
   * wanted 가 null 이면 전량, 숫자면 그만큼만 정리. 지정가 IOC(마크가 ∓ 1%)로, 남으면 최대 3번까지 다시 시도.
   * 손절/익절 플랜 주문은 '포지션이 0 이 된 뒤에만' 취소한다 — 먼저 취소하면 일부만 정리됐을 때 남은 물량이 손절 없이 방치된다 (감사 H1).
   * 부분 정리 뒤 수량이 남으면 플랜 주문은 그대로 둔다 (거래소가 수량을 맞추지 않아도 트리거는 유효).
   * 일부만 정리된 채 실패하면(PARTIAL_CLOSE) detail.filled 에 체결된 계약 수를 실어 던진다 — 카피 장부가 그만큼은 반영할 수 있게.
   */
  private async closeContracts(symbol: Symbol, contract: ContractInfo, wanted: number | null, opts: OrderOpts = {}): Promise<CloseResult> {
    const list = await this.openPositions(symbol);
    const p = list.find((x) => x.symbol === symbol);
    if (!p) throw new HttpError(404, '정리할 포지션이 없어요', 'NO_POSITION');
    const direction = positionDirection(p);
    if (!direction) throw new HttpError(404, '정리할 포지션이 없어요', 'NO_POSITION');
    let cur: WooxPositionV2 | undefined = p;
    let remaining = wanted ?? Number.POSITIVE_INFINITY;
    let filled = 0;
    let lastLeft = Math.abs(n(p.position_amount ?? p.current_amount));
    for (let attempt = 0; attempt < 3 && cur && remaining > 0; attempt++) {
      // 포지션 반영이 늦어 직전 주문의 체결이 아직 안 보이면(주문 조회로만 확인) lastLeft 가 더 작다 — 그 값을 쓴다 (같은 물량을 두 번 정리하지 않게)
      const size = Math.min(Math.abs(n(cur.position_amount ?? cur.current_amount)), lastLeft);
      if (!(size > 0)) break;
      const qty = Math.min(size, remaining);
      const mark = n(cur.mark_price) || n(cur.open_avg_price ?? cur.entry_price);
      // 정리 지정가는 강제정리 가격을 넘지 않게 자른다. 실측(2026-10-02 13:25·13:29, 팔로워 8~9명): 40배 격리 포지션이 1% 가까이 손실이면
      // 현재가±1% 지정가가 강제정리 가격 바깥이라 거래소가 40016("This order would trigger user position liquidate")으로 정리 주문 자체를 거절했다.
      // 거절 뒤 재시도(attempt>0)는 슬리피지를 0.2% 로 더 좁힌다
      const closePrice = closeLimitPrice(mark, direction, attempt === 0 ? CLOSE_SLIPPAGE : CLOSE_SLIPPAGE_TIGHT, n(cur.liquidation_price), contract);
      let r: { order_id: string; price?: string };
      try {
        r = await this.client.submitOrder({
        symbol,
        side: SIDE_CLOSE[direction],
        type: 'limit',
        price: closePrice,
        size: qty,
        leverage: String(n(cur.leverage, 1)),
        open_type: (cur.open_type === 'cross' ? 'cross' : 'isolated'),
        mode: 3,
        ...(opts.clientOrderId ? { client_order_id: attempt === 0 ? opts.clientOrderId : `${opts.clientOrderId}a${attempt}` } : {}),   // 재시도마다 다른 표식 (거래소가 같은 id 를 거절)
      });
      } catch (e) {
        // 그래도 40016 이면(강제정리 가격 추정 오차) 더 좁힌 가격으로 다음 시도. 마지막 시도였으면 그대로 던진다
        if (e instanceof WooxError && String(e.code) === '40016' && attempt < 2) { log.warn('close refused 40016 — retrying with tighter price', { symbol, attempt, closePrice, liq: cur.liquidation_price, mark }); continue; }
        throw e;
      }
      log.info('close order submitted', { symbol, direction, size: qty, partial: wanted !== null, orderId: r.order_id, attempt });
      // 체결 확인: 주문 1건 조회(최대 4번) → 포지션 1회 읽기. 조회가 안 됐으면 포지션 폴링 3번. 수량이 줄어든 게 보이면 그만큼, 조회로만 확인되면 deal_size 만큼
      let left = size;
      try {
        const fill = await this.pollOrderFill(symbol, String(r.order_id));
        const tries = fill ? 1 : 3;
        for (let k = 0; k < tries; k++) {
          if (k > 0) await sleep(200);
          cur = (await this.retry429(() => this.openPositions(symbol))).find((x) => x.symbol === symbol);
          left = cur ? Math.abs(n(cur.position_amount ?? cur.current_amount)) : 0;
          if (left < size) break;
        }
        if (fill && fill.dealSize > 0 && left > size - fill.dealSize) {
          // 포지션 반영이 늦음 → 주문 체결 수량으로 확정 (포지션이 더 줄었으면 그 값이 진실)
          left = Math.max(0, size - fill.dealSize);
          log.info('close filled per order lookup (position poll lagged)', { symbol, orderId: r.order_id, dealSize: fill.dealSize, left });
        }
      } catch (e) {
        // 정리 주문은 이미 들어갔다 — "거절"로 알리면 재시도로 반대 포지션이 열릴 수 있다(감사 B3). filled = 지금까지 확인된 정리 수량
        log.error('close order sent but confirmation failed', { symbol, orderId: r.order_id, attempt, message: (e as Error).message });
        throw new HttpError(409, '정리 주문은 접수됐지만 결과 확인에 실패했어요. 포지션을 확인한 뒤 다시 시도해 주세요', 'ORDER_SENT_UNCONFIRMED', { orderId: String(r.order_id), filled });
      }
      const done = Math.max(0, size - left);
      lastLeft = left;
      remaining -= done;   // 실제로 줄어든 만큼만 체결로 친다
      filled += done;
      if (!(left > 0)) cur = undefined;
    }
    if (cur && remaining > 0) {
      throw new HttpError(409, wanted === null
        ? '지금은 거래가 뜸해 일부만 정리됐어요. 남은 물량에는 손절이 그대로 걸려 있어요. 잠시 후 "전부 정리하기"를 다시 눌러 주세요'
        : '지금은 거래가 뜸해 일부만 정리됐어요. 남은 물량에는 손절이 그대로 걸려 있어요', 'PARTIAL_CLOSE', { filled, remaining: wanted === null ? lastLeft : remaining });
    }
    const result: CloseResult = { contracts: filled, pnl: null, fee: null };
    if (cur) return result; // 부분 정리 완료, 수량이 남음 → 플랜 주문 유지
    // 전부 정리됨 → 남은 플랜 주문 정리 (거래소가 자동 취소하지 않는 경우 대비). 조회는 엄격(실패 = 모름): 한 번 더 시도하고, 그래도 실패면 경고만 —
    // 포지션은 이미 0 이므로 정리 결과 자체는 성공으로 돌려준다 (실패로 던지면 호출자가 장부를 못 줄인다)
    let plans: WooxPlanOrder[] | null = null;
    for (let i = 0; i < 2 && plans === null; i++) {
      plans = await this.client.getCurrentPlanOrdersStrict(symbol).catch((e) => { log.warn('plan order read after close failed', { symbol, attempt: i, message: (e as Error).message }); return null; });
    }
    if (plans === null) log.error('plan orders unknown after full close — leftover TP/SL may remain', { symbol });
    for (const o of plans ?? []) {
      try { await this.client.cancelPlanOrder(symbol, o.order_id); }
      catch (e) { log.warn('cancel plan order failed', { message: (e as Error).message }); }
    }
    return result;
  }

  /** 배율 변경: submit-leverage(isolated). 거래소가 거절하면 WooxError 그대로 (호출자가 사람 말로 바꾼다) */
  async setLeverage(symbol: Symbol, leverage: number): Promise<void> {
    const lev = Math.max(1, Math.floor(leverage));
    if (!(lev >= 1)) throw badRequest('배율이 올바르지 않아요', 'BAD_LEVERAGE');
    try { await this.client.submitLeverage(symbol, lev, 'isolated'); return; }
    catch (e) {
      // 실측(2026-09-21, 대표 계정): 손절·익절 예약 주문이 걸려 있으면 40012("positions or orders … not supported")로 거절, 예약이 없으면 즉시 성공.
      // → 예약을 잠시 뺐다가 배율을 바꾸고, 성공·실패와 무관하게 곧바로 같은 값으로 다시 건다 (손절 없는 구간을 1초 미만으로)
      if (!(e instanceof WooxError && String(e.code) === '40012')) throw e;
      const plans = (await this.client.getCurrentPlanOrdersStrict(symbol)).filter((o) => o.type === 'stop_loss' || o.type === 'take_profit');
      if (plans.length === 0) throw e;
      const pos = (await this.openPositions(symbol)).find((x) => x.symbol === symbol);
      const direction = pos ? positionDirection(pos) : null;
      if (!pos || !direction) throw e;
      const size = Math.abs(n(pos.position_amount ?? pos.current_amount));
      const saved = plans.map((o) => ({ type: o.type as 'stop_loss' | 'take_profit', trigger: String(o.trigger_price), size: Number(o.size) > 0 ? Number(o.size) : size }));
      for (const o of plans) await this.client.cancelPlanOrder(symbol, o.order_id);
      log.warn('leverage change blocked by tp/sl plan orders — re-placing around the change', { symbol, lev, plans: saved.map((x) => `${x.type}@${x.trigger}`) });
      try { await this.client.submitLeverage(symbol, lev, 'isolated'); }
      finally {
        for (const o of saved) {
          await this.client.submitTpSl({ symbol, type: o.type, side: SIDE_CLOSE[direction], size: o.size, trigger_price: o.trigger, executive_price: o.trigger, price_type: PRICE_TYPE_FAIR, plan_category: 2, category: 'market' })
            .catch((err) => log.error('tp/sl re-place after leverage change FAILED — position may be without stop', { symbol, type: o.type, trigger: o.trigger, message: (err as Error).message }));
        }
      }
    }
  }

  async updateTpSl(req: UpdateTpSlRequest, contract: ContractInfo): Promise<void> {
    const list = await this.openPositions(req.symbol);
    const p = list.find((x) => x.symbol === req.symbol);
    const direction = p ? positionDirection(p) : null;
    if (!p || !direction) throw new HttpError(404, '포지션이 없어요', 'NO_POSITION');
    const size = Math.abs(n(p.position_amount ?? p.current_amount));
    const plans = await this.client.getCurrentPlanOrdersStrict(req.symbol);   // 조회 실패를 "없음" 으로 읽으면 손절이 두 개 생긴다 → 그대로 던진다
    const apply = async (kind: 'stop_loss' | 'take_profit', value: number | null | undefined) => {
      if (value === undefined) return;
      const cur = findPlan(plans, kind);
      if (value === null) {
        if (cur) await this.client.cancelPlanOrder(req.symbol, cur.order_id);
        return;
      }
      // 실측(2026-09-07): executive_price 는 submit 에서 필수(없으면 "Invalid Precision"). 가격은 거래소 단위로 반올림.
      const px = String(roundToPrecision(value, contract.pricePrecision));
      if (cur) {
        await this.client.modifyTpSl({ symbol: req.symbol, order_id: cur.order_id, trigger_price: px, executive_price: px, price_type: PRICE_TYPE_FAIR, plan_category: 2, category: 'market' });
      } else {
        await this.client.submitTpSl({
          symbol: req.symbol,
          type: kind,
          side: SIDE_CLOSE[direction],
          size,
          trigger_price: px,
          executive_price: px,
          price_type: PRICE_TYPE_FAIR,
          plan_category: 2,
          category: 'market',
        });
      }
    };
    await apply('stop_loss', req.stopLossPrice);
    await apply('take_profit', req.takeProfitPrice);
  }
}

function findPlan(plans: WooxPlanOrder[], kind: 'stop_loss' | 'take_profit'): { order_id: string; trigger: number } | null {
  const o = plans.find((x) => x.type === kind);
  return o ? { order_id: o.order_id, trigger: n(o.trigger_price) } : null;
}
