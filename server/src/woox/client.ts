// WOO X Pro REST 얇은 클라이언트. 경로/파라미터는 docs/woox-pro-api.md 기준.
// 인스턴스마다 사용자별 자격증명을 넣어 쓴다: new WooxClient({ credentials }). 서명은 WebCrypto(async).
import { buildHeaders } from '../sign.js';
import { log } from '../log.js';

export const WOOX_REST_BASE = 'https://cloud-api.wooxpro.com';

export interface WooxEnvelope<T> {
  code: number;
  message: string;
  data: T;
  trace?: string;
}

export class WooxError extends Error {
  constructor(
    message: string,
    public readonly code: number | string,
    public readonly httpStatus: number,
    public readonly path: string,
    public readonly trace?: string,
    /** 429 일 때 거래소가 알려 준(또는 기본 5초) 재시도 대기 시간(ms). 호출자가 Retry-After 로 되돌려 줄 수 있다 */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'WooxError';
  }
}

/** 429 응답 헤더에서 재시도 대기(ms). Retry-After(초) → x-bm-ratelimit-reset / x-ratelimit-reset(초) → 기본 5000 */
export interface RateLimitInfo { limit: number | null; remaining: number | null; reset: number | null; mode: string | null; at?: number }   // remaining = 실측상 '이 창에서 이미 쓴 횟수'(2026-09-28: 1회 호출 뒤 1)
/** BitMart 계열 응답 헤더 x-bm-ratelimit-{limit,remaining,reset,mode} (없으면 null) */
export function readRateLimit(h: Headers): RateLimitInfo | null {
  const num = (k: string) => { const v = h.get(k); const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
  const limit = num('x-bm-ratelimit-limit'), remaining = num('x-bm-ratelimit-remaining'), reset = num('x-bm-ratelimit-reset');
  const mode = h.get('x-bm-ratelimit-mode');
  if (limit == null && remaining == null && reset == null && !mode) return null;
  return { limit, remaining, reset, mode };
}
export function retryAfterFromHeaders(h: Headers, fallbackMs = 5000): number {
  for (const name of ['retry-after', 'x-bm-ratelimit-reset', 'x-ratelimit-reset']) {
    const sec = Number(h.get(name));
    if (Number.isFinite(sec) && sec > 0 && sec <= 3600) return Math.round(sec * 1000);
  }
  return fallbackMs;
}

export interface WooxCredentials {
  apiKey: string;
  apiSecret: string;
  memo: string;
}

export interface WooxClientOptions {
  baseUrl?: string;
  credentials?: Partial<WooxCredentials> | null;
  fetchImpl?: typeof fetch;
  gate?: ((path: string) => Promise<void>) | null;   // 거래소 요청 관문 (makeRateGate(env))
  timeoutMs?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

// ---- 응답 타입(문자열 숫자). 공개 필드는 2026-09-07 실측, 프라이빗은 실계정으로 검증 필요. ----
export interface WooxContractDetail {
  symbol: string;
  contract_size: string;   // BTCUSDT "0.001", ETHUSDT "0.001"
  price_precision: string; // BTCUSDT "0.1", ETHUSDT "0.01"
  vol_precision: string;   // "1"
  min_volume: string;      // "1"
  max_volume?: string;
  max_leverage: string;    // "200"
  min_leverage?: string;
  /** 주의(실측): 얇은 호가 탓에 비정상 값("644")이 오기도 함. 시세로 쓰지 말 것. */
  last_price?: string;
  /** 실측상 신뢰 가능한 지수 가격. REST 폴백 시세로 사용. */
  index_price?: string;
  change_24h?: string;
  high_24h?: string;
  low_24h?: string;
  funding_rate?: string;
  status?: string;
}

export interface WooxKline {
  timestamp: number; // 초
  open_price: string;
  high_price: string;
  low_price: string;
  close_price: string;
  volume: string;
}

export interface WooxAsset {
  currency: string;
  available_balance: string;
  equity: string;
  unrealized: string;
  position_deposit: string;
  frozen_balance?: string;
}

// TODO(verify-live): position-v2 실제 필드명 확인 (BitMart V2: current_amount/position_type, 문서 요약: position_amount/position_side)
export interface WooxPositionV2 {
  symbol: string;
  leverage: string;
  open_type?: string;
  position_amount?: string;
  current_amount?: string;
  position_side?: string; // long | short | both
  position_type?: number | string; // BitMart: 1=long 2=short
  entry_price?: string;
  open_avg_price?: string;
  mark_price?: string;
  liquidation_price?: string;
  unrealized_pnl?: string;
  unrealized_value?: string;
  initial_margin?: string;
  position_value?: string;
  open_timestamp?: number | string;
  timestamp?: number | string;
  position_mode?: string;
}

export interface WooxTrade {
  symbol: string;
  order_id: string;
  trade_id: string;
  side: number;
  price: string;
  vol: string;
  profit?: boolean;
  exec_type?: string;
  realised_profit?: string;
  paid_fees?: string;
  create_time: number;
}

export interface WooxOrder {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  side: number;
  type: string;
  size: string | number;
  price?: string;
  state?: number | string;      // BitMart: 1=approval 2=check 4=finish
  deal_size?: string | number;  // 체결된 계약 수
  deal_avg_price?: string;      // 체결 평균가
  [k: string]: unknown;
}
/** 주문 조회 결과 요약: 체결 수량·평균가 (deal_size 0 이면 미체결). 조회 자체가 실패하면 WooxError */
export interface WooxOrderFill { orderId: string; clientOrderId: string | null; dealSize: number; dealAvgPrice: number | null; state: number | null; finished: boolean }

// TODO(verify-live): 플랜(TP/SL) 주문 조회 응답 필드 확인
export interface WooxPlanOrder {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  side: number;
  type: string; // take_profit | stop_loss | plan
  trigger_price: string;
  price_type: number;
  plan_category?: number | string;
  category?: string;
  size?: string | number;
  executive_price?: string;
  [k: string]: unknown;
}

export interface SubmitOrderParams {
  symbol: string;
  side: number;
  type: 'limit' | 'market';
  size: number;
  leverage: string;
  open_type: 'cross' | 'isolated';
  mode?: 1 | 2 | 3 | 4; // 1 GTC, 2 FOK, 3 IOC, 4 MakerOnly
  price?: string;
  client_order_id?: string;
  preset_take_profit_price?: string;
  preset_stop_loss_price?: string;
  preset_take_profit_price_type?: 1 | 2;
  preset_stop_loss_price_type?: 1 | 2;
}

export interface SubmitTpSlParams {
  symbol: string;
  type: 'take_profit' | 'stop_loss';
  side: number;
  size?: number;
  trigger_price: string;
  executive_price?: string;
  price_type: 1 | 2;
  plan_category: 1 | 2;
  category: 'limit' | 'market';
  client_order_id?: string;
}

export interface ModifyTpSlParams {
  symbol: string;
  order_id?: string;
  client_order_id?: string;
  trigger_price: string;
  executive_price?: string;
  price_type: 1 | 2;
  plan_category?: 1 | 2;
  category?: 'limit' | 'market';
}

function buildQuery(query?: Query): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

/** signal 이 abort 되면 거절되는 프라미스 (본문 읽기 race 용). 이미 abort 됐으면 즉시 거절 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const err = () => reject(new Error('aborted'));
    if (signal.aborted) return err();
    signal.addEventListener('abort', err, { once: true });
  });
}

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
function toFill(o: WooxOrder): WooxOrderFill {
  const state = o.state === undefined || o.state === null || o.state === '' ? null : Number(o.state);
  return { orderId: String(o.order_id), clientOrderId: o.client_order_id ? String(o.client_order_id) : null, dealSize: Math.max(0, num(o.deal_size)), dealAvgPrice: num(o.deal_avg_price) > 0 ? num(o.deal_avg_price) : null, state, finished: state === 4 };
}

export class WooxClient {
  /** 서버 전체 요청 관문 (RateGate). 사설 경로 호출 전에 기다린다. DO 스텁은 만든 컨텍스트에서만 쓸 수 있어 정적 공유가 아니라 인스턴스마다 넣는다 */
  private readonly gate: ((path: string) => Promise<void>) | null;
  /** 경로별 마지막 요청 한도 헤더 (진단용) */
  readonly lastRateLimit = new Map<string, RateLimitInfo>();
  private readonly baseUrl: string;
  private readonly creds: Partial<WooxCredentials> | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WooxClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? WOOX_REST_BASE).replace(/\/$/, '');
    this.creds = opts.credentials ?? null;
    // 전역 fetch 를 그대로 저장하면 this 가 바뀌어 workerd 에서 "Illegal invocation" 이 난다 → 래핑
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.gate = opts.gate ?? null;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get hasCredentials(): boolean {
    return Boolean(this.creds?.apiKey && this.creds?.apiSecret && this.creds?.memo);
  }

  private requireCreds(): WooxCredentials {
    if (!this.hasCredentials) {
      throw new WooxError('API 키가 등록되어 있지 않아요', 'NO_CREDENTIALS', 0, '');
    }
    return this.creds as WooxCredentials;
  }

  /** GET. private=true면 서명 헤더 추가. 서명 본문 = 실제 전송 쿼리스트링(없으면 ''). */
  async get<T>(path: string, query?: Query, opts: { signed?: boolean } = {}): Promise<T> {
    const qs = buildQuery(query);
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.signed) {
      const c = this.requireCreds();
      Object.assign(headers, await buildHeaders(c.apiKey, c.apiSecret, c.memo, qs));
    }
    return this.request<T>('GET', path, url, headers);
  }

  /** POST(JSON). 항상 서명. 서명 본문 = 전송한 JSON 문자열 그대로. */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const c = this.requireCreds();
    const json = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(await buildHeaders(c.apiKey, c.apiSecret, c.memo, json)),
    };
    return this.request<T>('POST', path, `${this.baseUrl}${path}`, headers, json);
  }

  /**
   * 키별 요청 한도 선제 대기 (2026-09-28 실측: position-v2 6회/2초, assets-detail 12회/2초, order-history 6회/2초 — 모두 KEY 단위).
   * 직전 응답 헤더로 이 창에서 쓴 횟수를 알고 있으면, 한도 − 여유(1/3, 폰 앱의 3초 폴링 몫)에 닿았을 때 창이 끝날 때까지 기다린다 → 429 대신 1~2초 지연
   */
  private async throttle(path: string): Promise<void> {
    const rl = this.lastRateLimit.get(path);
    if (!rl || rl.limit == null || rl.remaining == null || rl.reset == null || rl.at == null) return;
    const reserve = Math.max(1, Math.ceil(rl.limit / 3));
    const resetAt = rl.at + rl.reset * 1000;
    if (rl.remaining >= rl.limit - reserve && Date.now() < resetAt) {
      const wait = Math.min(2500, resetAt - Date.now());
      log.info('woox throttle (per-key window nearly used)', { path, used: rl.remaining, limit: rl.limit, wait });
      await new Promise((r) => setTimeout(r, wait));
      this.lastRateLimit.delete(path);
    }
  }

  private async request<T>(method: string, path: string, url: string, headers: Record<string, string>, body?: string): Promise<T> {
    if (this.gate && path.startsWith('/contract/private/')) await this.gate(path);
    await this.throttle(path);
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: ctrl.signal });
      } catch (e) {
        throw new WooxError(`네트워크 오류: ${(e as Error).message}`, 'NETWORK', 0, path);
      }
      // 본문도 같은 타임아웃 안에서 읽는다 — 헤더만 오고 본문이 멈추면 모든 거래 경로가 무한 대기했다(감사 B1).
      // abort 신호가 본문 스트림까지 닿지 않는 구현도 있어 race 로 이중 보호
      try {
        text = await Promise.race([res.text(), rejectOnAbort(ctrl.signal)]);
      } catch (e) {
        throw new WooxError(timedOut ? '네트워크 오류: 응답 본문 시간 초과' : `네트워크 오류: ${(e as Error).message}`, 'NETWORK', 0, path);
      }
    } finally {
      clearTimeout(timer);
    }
    let parsed: WooxEnvelope<T> | undefined;
    try {
      parsed = JSON.parse(text) as WooxEnvelope<T>;
    } catch {
      /* not json */
    }
    // 거래소 요청 한도 헤더 기록 (팬아웃 429 원인 측정용): 경로별 마지막 값. 남은 횟수가 적으면 경고 로그
    const rl = readRateLimit(res.headers);
    if (rl) {
      rl.at = Date.now();
      this.lastRateLimit.set(path, rl);
      if (rl.remaining != null && rl.limit != null && rl.remaining >= rl.limit - 1) log.warn('woox rate limit nearly exhausted', { path, ...rl });   // remaining = 이 창에서 쓴 횟수
    }
    if (!res.ok) {
      if (res.status === 429) { log.warn('woox 429', { path, ...(rl ?? {}), retryAfter: res.headers.get('retry-after') }); throw new WooxError('요청이 너무 많아요', 'RATE_LIMITED', 429, path, parsed?.trace, retryAfterFromHeaders(res.headers)); }
      throw new WooxError(parsed?.message ?? `HTTP ${res.status}`, parsed?.code ?? res.status, res.status, path, parsed?.trace);
    }
    if (!parsed || typeof parsed.code !== 'number') {
      throw new WooxError('응답 형식을 알 수 없어요', 'BAD_RESPONSE', res.status, path);
    }
    if (parsed.code !== 1000) {
      throw new WooxError(parsed.message || `code ${parsed.code}`, parsed.code, res.status, path, parsed.trace);
    }
    return parsed.data;
  }

  // ---- 공개 ----
  async getContractDetails(symbol?: string): Promise<WooxContractDetail[]> {
    const data = await this.get<{ symbols: WooxContractDetail[] }>('/contract/public/details', { symbol });
    return data?.symbols ?? [];
  }

  /** step=분, 시작/끝 = 초 단위. 최대 500개. */
  async getKlines(symbol: string, stepMin: number, startSec: number, endSec: number): Promise<WooxKline[]> {
    const q = { symbol, step: stepMin, start_time: startSec, end_time: endSec };
    // 실측(2026-09-07): 공개 REST `kline`은 비어 있거나 644달러 같은 비정상 체결을 담는다.
    // 마크가격 K선만 사용한다 (docs/woox-pro-api.md '정정 및 결정' 절).
    const mark = await this.get<WooxKline[]>('/contract/public/markprice-kline', q);
    return Array.isArray(mark) ? mark : [];
  }

  // ---- 프라이빗 ----
  async getAssets(): Promise<WooxAsset[]> {
    const data = await this.get<WooxAsset[]>('/contract/private/assets-detail', undefined, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  async getPositionsV2(symbol?: string): Promise<WooxPositionV2[]> {
    const data = await this.get<WooxPositionV2[]>('/contract/private/position-v2', { symbol }, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  async getPositionMode(): Promise<string> {
    const data = await this.get<{ position_mode: string }>('/contract/private/get-position-mode', undefined, { signed: true });
    return data?.position_mode ?? '';
  }

  async setPositionMode(mode: 'one_way_mode' | 'hedge_mode'): Promise<string> {
    const data = await this.post<{ position_mode: string }>('/contract/private/set-position-mode', { position_mode: mode });
    return data?.position_mode ?? mode;
  }

  async submitLeverage(symbol: string, leverage: number, openType: 'cross' | 'isolated'): Promise<{ max_value?: string }> {
    return this.post('/contract/private/submit-leverage', { symbol, leverage: String(leverage), open_type: openType });
  }

  async submitOrder(params: SubmitOrderParams): Promise<{ order_id: string; price?: string }> {
    return this.post('/contract/private/submit-order', { ...params });
  }

  async submitTpSl(params: SubmitTpSlParams): Promise<{ order_id: string }> {
    return this.post('/contract/private/submit-tp-sl-order', { ...params });
  }

  async modifyTpSl(params: ModifyTpSlParams): Promise<{ order_id: string }> {
    return this.post('/contract/private/modify-tp-sl-order', { ...params });
  }

  /** 일반(지정가/시장가) 미체결 주문. TODO(verify-live): 플랜 주문 포함 여부 확인 */
  async getOpenOrders(symbol: string): Promise<WooxOrder[]> {
    const data = await this.get<WooxOrder[]>('/contract/private/get-open-orders', { symbol }, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  /**
   * 플랜(TP/SL) 미체결 주문 — 엄격 버전: 조회가 실패하면 그대로 던진다 ("조회 실패" 를 "손절 없음" 으로 읽으면 안 되는 자리에서 쓴다:
   * 손절 수정, 전량 정리 뒤 취소, 진입 뒤 손절 확인). 문서(plan-order.md): 쿼리 파라미터는 plan_type (profit_loss = TP/SL), limit 최대 100
   */
  async getCurrentPlanOrdersStrict(symbol: string, planType: 'plan' | 'profit_loss' = 'profit_loss'): Promise<WooxPlanOrder[]> {
    const data = await this.get<WooxPlanOrder[]>('/contract/private/current-plan-order', { symbol, plan_type: planType, limit: 100 }, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  /**
   * 플랜(TP/SL) 미체결 주문 — 관대한 버전: 실패 시 빈 배열 (화면 표시처럼 "모름 = 없음" 으로 보여도 되는 자리 전용).
   * TODO(verify-live): WOO X Pro 문서에 없는 경로 — 실계정에서 404/파라미터 확인.
   */
  async getCurrentPlanOrders(symbol: string, planType: 'plan' | 'profit_loss' = 'profit_loss'): Promise<WooxPlanOrder[]> {
    try {
      return await this.getCurrentPlanOrdersStrict(symbol, planType);
    } catch (e) {
      log.warn('woox.current-plan-order failed (treated as empty)', { message: (e as Error).message });
      return [];
    }
  }

  /**
   * 주문 1건 조회 (BitMart V2 `GET /contract/private/order?symbol&order_id` 또는 client_order_id). 체결 여부는 deal_size 로 판단.
   * 포지션 폴링이 "체결 없음" 이라고 해도 주문 자체가 체결됐을 수 있어(NO_FILL 오탐) 이 조회로 확정한다. 조회 실패는 WooxError 로 던진다
   */
  async getOrder(symbol: string, ref: { orderId?: string; clientOrderId?: string }): Promise<WooxOrderFill | null> {
    if (!ref.orderId && !ref.clientOrderId) return null;
    const data = await this.get<WooxOrder | WooxOrder[]>('/contract/private/order', { symbol, order_id: ref.orderId, client_order_id: ref.clientOrderId }, { signed: true });
    const o = Array.isArray(data) ? data[0] : data;
    if (!o || typeof o !== 'object' || !o.order_id) return null;
    return toFill(o);
  }

  /** 주문 이력에서 client_order_id 로 찾기 (getOrder 가 client id 조회를 지원하지 않을 때의 폴백). 최근 lookbackSec 초 */
  async findOrderByClientId(symbol: string, clientOrderId: string, lookbackSec = 3 * 3600): Promise<WooxOrderFill | null> {
    const endSec = Math.floor(Date.now() / 1000);
    const list = await this.getOrderHistory(symbol, endSec - lookbackSec, endSec);
    const o = list.find((x) => String(x.client_order_id ?? '') === clientOrderId);
    return o ? toFill(o) : null;
  }

  /** 체결 내역(trades.md). start/end 초 단위. */
  async getTrades(symbol: string, startSec: number, endSec: number): Promise<WooxTrade[]> {
    const data = await this.get<WooxTrade[]>('/contract/private/trades', { symbol, start_time: startSec, end_time: endSec }, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  /** 주문 이력(order-history.md): 주문 type(liquidate/planorder 등) 확인용. */
  async getOrderHistory(symbol: string, startSec: number, endSec: number): Promise<WooxOrder[]> {
    const data = await this.get<WooxOrder[]>('/contract/private/order-history', { symbol, start_time: startSec, end_time: endSec }, { signed: true });
    return Array.isArray(data) ? data : [];
  }

  async cancelOrder(symbol: string, orderId?: string, clientOrderId?: string): Promise<void> {
    await this.post('/contract/private/cancel-order', { symbol, order_id: orderId, client_order_id: clientOrderId });
  }

  /** 심볼의 모든 일반 주문 취소. TODO(verify-live): 플랜(TP/SL) 주문까지 취소되는지 확인 */
  async cancelAllOrders(symbol: string): Promise<void> {
    await this.post('/contract/private/cancel-orders', { symbol });
  }

  /** 플랜 주문 취소. TODO(verify-live): BitMart V2 경로 가정 */
  async cancelPlanOrder(symbol: string, orderId?: string, clientOrderId?: string): Promise<void> {
    await this.post('/contract/private/cancel-plan-order', { symbol, order_id: orderId, client_order_id: clientOrderId });
  }
}
