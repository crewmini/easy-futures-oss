// 워커에서 PaperEngine DO 를 호출하는 얇은 클라이언트.
import type { ContractInfo, OpenOrderRequest, OpenOrderResult, Position, Symbol, UpdateTpSlRequest, Wallet } from '@easy-futures/shared';
import type { Env } from '../env.js';
import { HttpError } from '../errors.js';
import { log } from '../log.js';
import type { PaperEvent } from './engine.js';
import type { PricesResponse } from './PaperEngine.js';

export interface PaperState extends PricesResponse {
  wallet: Wallet;
  positions: Position[];
  history: PaperEvent[];
}

// 시세는 격리환경 단위로 1초 캐시. 사용자 수만큼 DO 를 호출하지 않는다.
let pricesCache: { at: number; value: Promise<PricesResponse> } | null = null;
const PRICES_TTL_MS = 1000;
const CALL_TIMEOUT_MS = 3000;

export class PaperClient {
  private readonly stub: DurableObjectStub;
  constructor(env: Env) {
    this.stub = env.PAPER.get(env.PAPER.idFromName('global'));
  }

  /**
   * DO 호출 = 3초 안에 본문까지. 시세 DO 하나가 멈추면 실거래 /api/state·주문이 전부 무한 대기했다(감사 B6) → 503 PRICE_UNAVAILABLE.
   * 본문이 JSON 이 아니어도(DO 예외 텍스트) 같은 503 으로 깔끔하게
   */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const unavailable = () => path === '/prices'
      ? new HttpError(503, '시세를 불러오지 못했어요', 'PRICE_UNAVAILABLE')
      : new HttpError(503, '거래 엔진이 응답하지 않아요. 잠시 후 다시 해 주세요', 'ENGINE_UNAVAILABLE');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), CALL_TIMEOUT_MS); });
    let text: string;
    let status: number;
    try {
      const res = await Promise.race([this.stub.fetch(`https://paper${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), timeout]);
      status = res.status;
      text = await Promise.race([res.text(), timeout]);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log.warn('paper engine call failed', { path, message: (e as Error).message });
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    let data: T & { error?: string; code?: string | number; detail?: unknown };
    try { data = JSON.parse(text); }
    catch { log.warn('paper engine returned non-JSON', { path, status, head: text.slice(0, 120) }); throw unavailable(); }
    if (status < 200 || status >= 300) throw new HttpError(status, data.error ?? '연습 엔진 오류', data.code, data.detail);
    return data;
  }

  prices(): Promise<PricesResponse> {
    const now = Date.now();
    if (pricesCache && now - pricesCache.at < PRICES_TTL_MS) return pricesCache.value;
    const value = this.call<PricesResponse>('/prices').catch((e) => { pricesCache = null; throw e; });
    pricesCache = { at: now, value };
    return value;
  }
  state(userId: number, lite = false): Promise<PaperState> {
    return this.call(`/state?userId=${userId}${lite ? '&lite=1' : ''}`);
  }
  open(userId: number, req: OpenOrderRequest, contracts: number, contract: ContractInfo): Promise<OpenOrderResult> {
    return this.call('/open', { userId, req, contracts, contract });
  }
  close(userId: number, symbol: Symbol): Promise<{ ok: true; contracts?: number; pnl?: number; fee?: number }> {
    return this.call('/close', { userId, symbol });
  }
  /** 부분 정리. 돌려주는 contracts 는 실제로 정리된 계약 수 */
  reduce(userId: number, symbol: Symbol, contracts: number): Promise<{ ok: true; contracts: number; pnl: number; fee: number }> {
    return this.call('/reduce', { userId, symbol, contracts });
  }
  tpsl(userId: number, req: UpdateTpSlRequest): Promise<{ ok: true }> {
    return this.call('/tpsl', { userId, req });
  }
  setLeverage(userId: number, symbol: Symbol, leverage: number): Promise<{ ok: true }> {
    return this.call('/leverage', { userId, symbol, leverage });
  }
  reset(userId: number): Promise<{ ok: true }> {
    return this.call('/reset', { userId });
  }
}
