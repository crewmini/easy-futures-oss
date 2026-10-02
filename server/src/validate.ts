// 요청 검증. 메시지는 모두 우리말(docs/api-contract.md 검증 규칙).
import {
  SYMBOLS,
  type Direction,
  type OpenOrderRequest,
  type Settings,
  type Symbol,
  type UpdateTpSlRequest,
  type Mode,
} from '@easy-futures/shared';
import { badRequest } from './errors.js';

type Body = Record<string, unknown>;

export function asBody(v: unknown): Body {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function parseSymbol(v: unknown): Symbol {
  if (typeof v === 'string' && (SYMBOLS as string[]).includes(v)) return v as Symbol;
  throw badRequest(`종목이 올바르지 않아요 (${SYMBOLS.join(', ')})`, 'BAD_SYMBOL');
}

function parseDirection(v: unknown): Direction {
  if (v === 'long' || v === 'short') return v;
  throw badRequest('방향이 올바르지 않아요 (오른다/내린다)', 'BAD_DIRECTION');
}

/** 손절가 방향 검증: long 은 현재가 미만, short 는 초과. */
export function checkStopLoss(sl: number, direction: Direction, price: number): void {
  if (!(sl > 0)) throw badRequest('손절가는 꼭 넣어야 해요', 'SL_REQUIRED');
  if (direction === 'long' && sl >= price) throw badRequest('손절가는 지금 가격보다 낮아야 해요', 'SL_SIDE');
  if (direction === 'short' && sl <= price) throw badRequest('손절가는 지금 가격보다 높아야 해요', 'SL_SIDE');
}

/** 익절가 방향 검증: long 은 현재가 초과, short 는 미만. */
export function checkTakeProfit(tp: number, direction: Direction, price: number): void {
  if (!(tp > 0)) throw badRequest('익절가가 올바르지 않아요', 'TP_BAD');
  if (direction === 'long' && tp <= price) throw badRequest('익절가는 지금 가격보다 높아야 해요', 'TP_SIDE');
  if (direction === 'short' && tp >= price) throw badRequest('익절가는 지금 가격보다 낮아야 해요', 'TP_SIDE');
}

/**
 * 주문 표식(client_order_id): 웹이 시트를 열 때 만들어 재시도에도 같은 값을 보낸다 → 서버가 중복 진입을 가린다(감사 B2).
 * 없으면 서버가 만든다(`sv` + 시각 + 난수, 8~32자 영숫자·_-). 형식이 틀리면 400
 */
export const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
export function parseClientOrderId(v: unknown): { id: string; supplied: boolean } {
  if (v === undefined || v === null || v === '') {
    return { id: `sv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 32), supplied: false };
  }
  if (typeof v !== 'string' || !CLIENT_ORDER_ID_RE.test(v)) throw badRequest('주문 표식이 올바르지 않아요', 'BAD_CLIENT_ORDER_ID');
  return { id: v, supplied: true };
}

/** POST /api/order/open 본문 검증. price = 해당 종목 현재가(last). */
export function validateOpenOrder(raw: unknown, settings: Settings, price: number): OpenOrderRequest {
  const b = asBody(raw);
  const symbol = parseSymbol(b.symbol);
  const direction = parseDirection(b.direction);
  if (!(price > 0)) throw badRequest('지금 가격을 아직 못 받았어요. 잠시 후 다시 해 주세요', 'NO_PRICE');

  const leverage = num(b.leverage);
  if (leverage === undefined || !Number.isInteger(leverage) || leverage < 1 || leverage > settings.maxLeverage) {
    throw badRequest(`배율은 1배부터 ${settings.maxLeverage}배까지만 가능해요`, 'BAD_LEVERAGE');
  }
  const amountUsdt = num(b.amountUsdt);
  if (amountUsdt === undefined || !(amountUsdt > 0)) throw badRequest('금액을 넣어 주세요', 'BAD_AMOUNT');
  if (amountUsdt > settings.maxAmountUsdt) throw badRequest(`한 번에 ${settings.maxAmountUsdt} USDT까지만 가능해요`, 'AMOUNT_TOO_BIG');

  const sl = num(b.stopLossPrice);
  if (sl === undefined || Number.isNaN(sl)) throw badRequest('손절가는 꼭 넣어야 해요', 'SL_REQUIRED');
  checkStopLoss(sl, direction, price);

  let takeProfitPrice: number | null = null;
  const tp = num(b.takeProfitPrice);
  if (tp !== undefined) {
    if (Number.isNaN(tp)) throw badRequest('익절가가 올바르지 않아요', 'TP_BAD');
    checkTakeProfit(tp, direction, price);
    takeProfitPrice = tp;
  }
  // 내 돈 기준 % (선택). 손절은 0~100% 미만(100%=강제정리), 익절은 0 초과.
  const slRoi = num(b.stopLossRoiPct);
  const tpRoi = num(b.takeProfitRoiPct);
  const stopLossRoiPct = slRoi !== undefined && slRoi > 0 && slRoi < 100 ? slRoi : null;
  const takeProfitRoiPct = tpRoi !== undefined && tpRoi > 0 && tpRoi <= 1000 ? tpRoi : null;
  return { symbol, direction, amountUsdt, leverage, stopLossPrice: sl, takeProfitPrice, stopLossRoiPct, takeProfitRoiPct };
}

/** POST /api/position/tpsl. undefined=변경 없음, null=삭제. */
export function validateTpSl(raw: unknown, direction: Direction, price: number): UpdateTpSlRequest {
  const b = asBody(raw);
  const symbol = parseSymbol(b.symbol);
  const out: UpdateTpSlRequest = { symbol };
  if ('stopLossPrice' in b) {
    if (b.stopLossPrice === null) out.stopLossPrice = null;
    else {
      const sl = num(b.stopLossPrice);
      if (sl === undefined || Number.isNaN(sl)) throw badRequest('손절가가 올바르지 않아요', 'SL_BAD');
      checkStopLoss(sl, direction, price);
      out.stopLossPrice = sl;
    }
  }
  if ('takeProfitPrice' in b) {
    if (b.takeProfitPrice === null) out.takeProfitPrice = null;
    else {
      const tp = num(b.takeProfitPrice);
      if (tp === undefined || Number.isNaN(tp)) throw badRequest('익절가가 올바르지 않아요', 'TP_BAD');
      checkTakeProfit(tp, direction, price);
      out.takeProfitPrice = tp;
    }
  }
  if (out.stopLossPrice === undefined && out.takeProfitPrice === undefined) throw badRequest('바꿀 값이 없어요', 'NOTHING');
  return out;
}

export const PAPER_DISABLED_MSG = '연습 모드는 더 이상 제공하지 않아요';

/** PUT /api/settings (부분 갱신). live 전환은 hasApiKey 일 때만. paper 전환은 paperAllowed(관리자 또는 ALLOW_PAPER=on) 일 때만. */
export function validateSettings(raw: unknown, current: Settings, hasApiKey: boolean, kycApproved = true, paperAllowed = true): Settings {
  const b = asBody(raw);
  const next: Settings = { ...current };
  if ('mode' in b) {
    const m = b.mode as Mode;
    if (m !== 'paper' && m !== 'live') throw badRequest('모드가 올바르지 않아요', 'BAD_MODE');
    if (m === 'paper' && !paperAllowed) throw badRequest(PAPER_DISABLED_MSG, 'PAPER_DISABLED');
    if (m === 'live' && !hasApiKey) throw badRequest('실거래를 하려면 먼저 API 키를 등록해 주세요', 'NO_API_KEY');
    if (m === 'live' && !kycApproved) throw badRequest('신분증 인증이 끝나야 실거래를 할 수 있어요', 'KYC_REQUIRED');
    next.mode = m;
  }
  if ('maxLeverage' in b) {
    const v = num(b.maxLeverage);
    if (v === undefined || !Number.isInteger(v) || v < 1 || v > 100) throw badRequest('최대 배율은 1~100 사이 정수여야 해요', 'BAD_MAX_LEVERAGE');
    next.maxLeverage = v;
  }
  if ('maxAmountUsdt' in b) {
    const v = num(b.maxAmountUsdt);
    if (v === undefined || !(v > 0) || v > 1_000_000) throw badRequest('1회 최대 금액이 올바르지 않아요', 'BAD_MAX_AMOUNT');
    next.maxAmountUsdt = v;
  }
  if ('usdtKrw' in b) {
    const v = num(b.usdtKrw);
    if (v === undefined || !(v > 0)) throw badRequest('환율이 올바르지 않아요', 'BAD_USDT_KRW');
    next.usdtKrw = v;
  }
  return next;
}

export function validateLoginId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9]{3,20}$/.test(v)) throw badRequest('아이디는 영문·숫자 3~20자로 해 주세요', 'BAD_LOGIN_ID');
  return v;
}

/** 제휴사 신청 본문: 소속·이름·전화(+82). 전화는 E.164(+82…)로 정규화 */
export function validatePartnerApplication(raw: unknown): { company: string; name: string; phone: string } {
  const b = asBody(raw);
  const company = typeof b.company === 'string' ? b.company.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const phoneRaw = typeof b.phone === 'string' ? b.phone.trim() : '';
  if (company.length < 1 || company.length > 60) throw badRequest('소속을 넣어 주세요 (60자 이내)', 'BAD_COMPANY');
  if (name.length < 1 || name.length > 40) throw badRequest('이름을 넣어 주세요 (40자 이내)', 'BAD_NAME');
  let digits = phoneRaw.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+82')) digits = digits.slice(3);
  else if (digits.startsWith('82') && digits.length >= 11) digits = digits.slice(2);
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^1[0-9]{8,9}$/.test(digits)) throw badRequest('전화번호는 +82 뒤에 010-1234-5678 형식으로 넣어 주세요', 'BAD_PHONE');
  return { company, name, phone: '+82' + digits };
}

/** 경로 파라미터의 사용자 id (양의 정수) */
export function parseUserIdParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('사용자 번호가 올바르지 않아요', 'BAD_USER_ID');
  return n;
}

/** 거래소 UID: 9로 시작하는 숫자 8자리 */
export function validateUid(v: unknown): string {
  const u = typeof v === 'string' ? v.trim() : '';
  if (!u) throw badRequest('UID를 넣어 주세요 (9로 시작하는 숫자 8자리)', 'BAD_UID');
  if (!/^\d+$/.test(u)) throw badRequest('UID는 숫자만 넣어 주세요', 'BAD_UID');
  if (u.length !== 8) throw badRequest(`UID는 8자리여야 해요 (지금 ${u.length}자리)`, 'BAD_UID');
  if (!u.startsWith('9')) throw badRequest('UID는 9로 시작해야 해요', 'BAD_UID');
  return u;
}

export function validatePassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < 6 || v.length > 200) throw badRequest('비밀번호는 6자 이상으로 해 주세요', 'BAD_PASSWORD');
  return v;
}

export function validateApiKeyBody(raw: unknown): { apiKey: string; apiSecret: string; memo: string } {
  const b = asBody(raw);
  const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  const apiSecret = typeof b.apiSecret === 'string' ? b.apiSecret.trim() : '';
  const memo = typeof b.memo === 'string' ? b.memo.trim() : '';
  if (!apiKey || !apiSecret) throw badRequest('API 키와 시크릿을 모두 넣어 주세요', 'BAD_KEY');
  if (!memo) throw badRequest('메모(Memo)도 넣어 주세요. 키를 만들 때 적은 메모예요', 'BAD_MEMO');
  if (apiKey.length > 200 || apiSecret.length > 200 || memo.length > 100) throw badRequest('값이 너무 길어요', 'BAD_KEY');
  return { apiKey, apiSecret, memo };
}
