// 연습(paper) 엔진의 순수 로직. Durable Object API 에 의존하지 않아 단위 테스트가 쉽다.
// 규칙: 격리마진, 시장가는 last 로 체결, 테이커 수수료 0.05%, 종목당 포지션 1개(같은 방향은 평단 합산, 반대 방향은 거부).
import {
  priceAtRoi,
  calcPnl,
  estimateLiquidation,
  type ContractInfo,
  type Direction,
  type OpenOrderRequest,
  type OpenOrderResult,
  type Position,
  type Price,
  type Symbol,
  type UpdateTpSlRequest,
  type Wallet,
} from '@easy-futures/shared';
import { HttpError, badRequest } from '../errors.js';

export const TAKER_FEE = 0.0005;
export const HISTORY_MAX = 100;

export interface PaperPosition {
  symbol: Symbol;
  direction: Direction;
  contracts: number;
  contractSize: number;
  entryPrice: number;
  leverage: number;
  marginUsdt: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  liquidationPrice: number;
  openedAt: number;
}

export type PaperEventType = 'open' | 'close' | 'sl' | 'tp' | 'liq' | 'tpsl' | 'leverage' | 'reset';

export interface PaperEvent {
  t: number;
  type: PaperEventType;
  symbol?: Symbol;
  direction?: Direction;
  contracts?: number;
  price?: number;
  pnl?: number;
  fee?: number;
  orderId?: string;   // open 이벤트: 주문 id (자동매매 실행 기록과 연결)
}

export interface PaperAccount {
  balance: number; // 포지션에 묶이지 않은 돈 (available)
  positions: PaperPosition[];
  history: PaperEvent[];
}

export function newAccount(startBalance: number, now = Date.now()): PaperAccount {
  return { balance: startBalance, positions: [], history: [{ t: now, type: 'reset' }] };
}

export function resetAccount(acc: PaperAccount, startBalance: number, now = Date.now()): void {
  acc.balance = startBalance;
  acc.positions = [];
  acc.history = [];
  pushEvent(acc, { t: now, type: 'reset' });
}

function pushEvent(acc: PaperAccount, ev: PaperEvent): PaperEvent {
  acc.history.push(ev);
  if (acc.history.length > HISTORY_MAX) acc.history.splice(0, acc.history.length - HISTORY_MAX);
  return ev;
}

function round(n: number, d = 6): number {
  return Number(n.toFixed(d));
}

export function findPosition(acc: PaperAccount, symbol: Symbol): PaperPosition | undefined {
  return acc.positions.find((p) => p.symbol === symbol);
}

/** 시장가 진입. contracts 는 라우트에서 calcContracts 로 계산해 넘긴다. */
export function openPosition(
  acc: PaperAccount,
  req: OpenOrderRequest,
  contracts: number,
  contract: ContractInfo,
  price: number,
  now = Date.now(),
): OpenOrderResult {
  if (!(contracts > 0)) throw badRequest('금액이 너무 적어요', 'TOO_SMALL');
  if (!(price > 0)) throw badRequest('지금 가격을 아직 못 받았어요. 잠시 후 다시 해 주세요', 'NO_PRICE');
  if (!(req.leverage >= 1)) throw badRequest('배율이 올바르지 않아요', 'BAD_LEVERAGE');

  const existing = findPosition(acc, req.symbol);
  if (existing && existing.direction !== req.direction) {
    throw badRequest('반대 방향 포지션이 있어요. 먼저 정리해 주세요', 'OPPOSITE_POSITION');
  }

  const coinAmount = contracts * contract.contractSize;
  const notional = coinAmount * price;
  const margin = notional / req.leverage;
  const fee = notional * TAKER_FEE;
  if (acc.balance < margin + fee) {
    throw badRequest(`연습 잔고가 부족해요 (필요 ${round(margin + fee, 2)} USDT, 남은 돈 ${round(acc.balance, 2)} USDT)`, 'INSUFFICIENT');
  }

  acc.balance = round(acc.balance - margin - fee);
  let pos: PaperPosition;
  if (existing) {
    const totalContracts = existing.contracts + contracts;
    const entry = (existing.entryPrice * existing.contracts + price * contracts) / totalContracts;
    const totalMargin = existing.marginUsdt + margin;
    const totalNotional = entry * totalContracts * contract.contractSize;
    const leverage = round(totalNotional / totalMargin, 2);
    existing.contracts = totalContracts;
    existing.entryPrice = round(entry);
    existing.marginUsdt = round(totalMargin);
    existing.leverage = leverage;
    existing.liquidationPrice = round(estimateLiquidation(existing.entryPrice, leverage, existing.direction));
    existing.stopLossPrice = roiPrice(req, existing.entryPrice, leverage, 'sl') ?? req.stopLossPrice;
    existing.takeProfitPrice = roiPrice(req, existing.entryPrice, leverage, 'tp') ?? req.takeProfitPrice ?? null;
    pos = existing;
  } else {
    pos = {
      symbol: req.symbol,
      direction: req.direction,
      contracts,
      contractSize: contract.contractSize,
      entryPrice: price,
      leverage: req.leverage,
      marginUsdt: round(margin),
      stopLossPrice: roiPrice(req, price, req.leverage, 'sl') ?? req.stopLossPrice,
      takeProfitPrice: roiPrice(req, price, req.leverage, 'tp') ?? req.takeProfitPrice ?? null,
      liquidationPrice: round(estimateLiquidation(price, req.leverage, req.direction)),
      openedAt: now,
    };
    acc.positions.push(pos);
  }
  const orderId = `paper-${now}-${Math.floor(Math.random() * 1e6)}`;
  pushEvent(acc, { t: now, type: 'open', symbol: req.symbol, direction: req.direction, contracts, price, fee: round(fee), orderId });
  const adjusted = pos.stopLossPrice !== req.stopLossPrice || (pos.takeProfitPrice ?? null) !== (req.takeProfitPrice ?? null);
  return { orderId, contracts, coinAmount: round(coinAmount, 8), entryPrice: price, stopLossPrice: pos.stopLossPrice, takeProfitPrice: pos.takeProfitPrice, adjusted };
}

/** 내 돈 기준 %가 있으면 체결 평단 기준으로 손절/익절가 계산 (실거래 어댑터와 동일 규칙). */
function roiPrice(req: OpenOrderRequest, entry: number, leverage: number, kind: 'sl' | 'tp'): number | null {
  const pct = kind === 'sl' ? req.stopLossRoiPct : req.takeProfitRoiPct;
  if (!pct) return null;
  return round(priceAtRoi(entry, pct, leverage, req.direction, kind), 2);
}

/**
 * 정리. contracts 를 주면 그만큼만 부분 정리(손익·수수료·증거금은 비례, 나머지는 같은 평단·배율·손절·익절 유지),
 * 없거나 보유량 이상이면 전량. reason 이 liq 이면 증거금 전액 손실로 처리(항상 전량).
 */
export function closePosition(
  acc: PaperAccount,
  symbol: Symbol,
  price: number,
  reason: 'close' | 'sl' | 'tp' | 'liq' = 'close',
  now = Date.now(),
  contracts?: number,
): PaperEvent {
  const idx = acc.positions.findIndex((p) => p.symbol === symbol);
  if (idx < 0) throw new HttpError(404, '정리할 포지션이 없어요', 'NO_POSITION');
  if (!(price > 0)) throw badRequest('지금 가격을 아직 못 받았어요. 잠시 후 다시 해 주세요', 'NO_PRICE');
  const pos = acc.positions[idx];
  const wanted = reason === 'liq' || contracts === undefined ? pos.contracts : Math.floor(contracts);
  if (!(wanted > 0)) throw badRequest('정리할 계약 수가 올바르지 않아요', 'BAD_CONTRACTS');
  const closing = Math.min(wanted, pos.contracts);
  const partial = closing < pos.contracts;
  const marginPart = partial ? round(pos.marginUsdt * (closing / pos.contracts)) : pos.marginUsdt;
  const coinAmount = closing * pos.contractSize;
  let pnl: number;
  let fee: number;
  if (reason === 'liq') {
    pnl = -marginPart;
    fee = 0;
  } else {
    pnl = calcPnl(pos.entryPrice, price, coinAmount, pos.direction);
    fee = coinAmount * price * TAKER_FEE;
    // 격리마진: 손실은 (정리하는 몫의) 증거금을 넘지 않는다.
    if (pnl - fee < -marginPart) {
      pnl = -marginPart;
      fee = 0;
    }
  }
  acc.balance = round(acc.balance + marginPart + pnl - fee);
  if (partial) {
    pos.contracts -= closing;
    pos.marginUsdt = round(pos.marginUsdt - marginPart);
  } else {
    acc.positions.splice(idx, 1);
  }
  return pushEvent(acc, {
    t: now,
    type: reason,
    symbol,
    direction: pos.direction,
    contracts: closing,
    price,
    pnl: round(pnl),
    fee: round(fee),
  });
}

/** 부분 정리 (카피 트레이딩 reduce 용). contracts 가 보유량 이상이면 전량 정리와 같다. */
export function reducePosition(acc: PaperAccount, symbol: Symbol, contracts: number, price: number, now = Date.now()): PaperEvent {
  return closePosition(acc, symbol, price, 'close', now, contracts);
}

export function updateTpSl(acc: PaperAccount, req: UpdateTpSlRequest, now = Date.now()): void {
  const pos = findPosition(acc, req.symbol);
  if (!pos) throw new HttpError(404, '포지션이 없어요', 'NO_POSITION');
  if (req.stopLossPrice !== undefined) pos.stopLossPrice = req.stopLossPrice;
  if (req.takeProfitPrice !== undefined) pos.takeProfitPrice = req.takeProfitPrice;
  pushEvent(acc, { t: now, type: 'tpsl', symbol: req.symbol, direction: pos.direction });
}

/** 열린 포지션의 배율 변경 (격리마진): 증거금 = 명목(평단 기준)/배율 로 다시 잡고 차액을 잔고와 주고받는다. 강제정리 가격도 다시 계산 */
export function setLeverage(acc: PaperAccount, symbol: Symbol, leverage: number, now = Date.now()): void {
  const pos = findPosition(acc, symbol);
  if (!pos) throw new HttpError(404, '포지션이 없어요', 'NO_POSITION');
  const lev = Math.floor(leverage);
  if (!(lev >= 1)) throw badRequest('배율이 올바르지 않아요', 'BAD_LEVERAGE');
  const notional = pos.contracts * pos.contractSize * pos.entryPrice;
  const margin = round(notional / lev);
  const delta = margin - pos.marginUsdt;   // 배율을 낮추면 증거금을 더 넣어야 한다
  if (delta > 0 && acc.balance < delta) throw badRequest(`연습 잔고가 부족해요 (배율을 낮추려면 ${round(delta, 2)} USDT 더 필요)`, 'INSUFFICIENT');
  acc.balance = round(acc.balance - delta);
  pos.marginUsdt = margin;
  pos.leverage = lev;
  pos.liquidationPrice = round(estimateLiquidation(pos.entryPrice, lev, pos.direction));
  pushEvent(acc, { t: now, type: 'leverage', symbol, direction: pos.direction });
}

/** 매 틱마다 호출. 강제정리 → 손절 → 익절 순으로 판정하고 발생한 이벤트를 돌려준다. */
export function checkTriggers(acc: PaperAccount, prices: Partial<Record<Symbol, number>>, now = Date.now()): PaperEvent[] {
  const events: PaperEvent[] = [];
  for (const pos of [...acc.positions]) {
    const price = prices[pos.symbol];
    if (!(price && price > 0)) continue;
    const long = pos.direction === 'long';
    const hit = (level: number | null, below: boolean) => level !== null && level > 0 && (below ? price <= level : price >= level);
    if (hit(pos.liquidationPrice, long)) {
      events.push(closePosition(acc, pos.symbol, price, 'liq', now));
    } else if (hit(pos.stopLossPrice, long)) {
      events.push(closePosition(acc, pos.symbol, price, 'sl', now));
    } else if (hit(pos.takeProfitPrice, !long)) {
      events.push(closePosition(acc, pos.symbol, price, 'tp', now));
    }
  }
  return events;
}

export function toPositions(acc: PaperAccount, prices: Partial<Record<Symbol, Price>>): Position[] {
  return acc.positions.map((p) => {
    const mark = prices[p.symbol]?.last ?? p.entryPrice;
    const coinAmount = p.contracts * p.contractSize;
    const pnl = calcPnl(p.entryPrice, mark, coinAmount, p.direction);
    return {
      symbol: p.symbol,
      direction: p.direction,
      contracts: p.contracts,
      coinAmount: round(coinAmount, 8),
      entryPrice: p.entryPrice,
      markPrice: mark,
      leverage: p.leverage,
      marginUsdt: p.marginUsdt,
      notionalUsdt: round(coinAmount * mark, 4),
      unrealizedPnl: round(pnl, 4),
      unrealizedPct: p.marginUsdt > 0 ? round((pnl / p.marginUsdt) * 100, 2) : 0,
      liquidationPrice: p.liquidationPrice,
      stopLossPrice: p.stopLossPrice,
      takeProfitPrice: p.takeProfitPrice,
      openedAt: p.openedAt,
    };
  });
}

export function toWallet(acc: PaperAccount, prices: Partial<Record<Symbol, Price>>): Wallet {
  let margin = 0;
  let unrealized = 0;
  for (const p of acc.positions) {
    margin += p.marginUsdt;
    const mark = prices[p.symbol]?.last ?? p.entryPrice;
    unrealized += calcPnl(p.entryPrice, mark, p.contracts * p.contractSize, p.direction);
  }
  return {
    currency: 'USDT',
    available: round(acc.balance, 4),
    equity: round(acc.balance + margin + unrealized, 4),
    unrealized: round(unrealized, 4),
    positionMargin: round(margin, 4),
  };
}
