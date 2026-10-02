// Durable Object `PaperEngine` (싱글턴 'global'):
//  - 거래소 공개 티커 WS 1개를 유지해 BTC/ETH 시세를 메모리에 보관 (실패 시 REST 폴링 폴백)
//  - 모든 연습 계좌를 메모리 + DO 스토리지에 보관하고 매 틱마다 손절/익절/강제정리 판정
//  - 워커와는 fetch() JSON 라우트로 통신: /prices /state /open /close /reduce /tpsl /leverage /reset
import { DurableObject } from 'cloudflare:workers';
import { SYMBOLS, type ContractInfo, type OpenOrderRequest, type Price, type Symbol, type UpdateTpSlRequest } from '@easy-futures/shared';
import type { Env } from '../env.js';
import { numVar } from '../env.js';
import { HttpError } from '../errors.js';
import { log } from '../log.js';
import { WooxClient } from '../woox/client.js';
import {
  checkTriggers,
  closePosition,
  newAccount,
  openPosition,
  reducePosition,
  resetAccount,
  setLeverage,
  toPositions,
  toWallet,
  updateTpSl,
  type PaperAccount,
} from './engine.js';

export const WOOX_WS_URL = 'https://cloud-ws.wooxpro.com/api?protocol=1.1'; // fetch 업그레이드용 (wss → https)
const ALARM_HEALTHY_MS = 20_000; // WS 정상일 때 워치독 주기
const ALARM_POLL_MS = 3_000; // WS 불량 시 REST 폴링 주기
const PING_AFTER_MS = 15_000; // 이 시간 동안 메시지가 없으면 ping
const STALE_MS = 30_000; // 이보다 오래된 시세면 끊긴 것으로 간주
const WS_CONNECT_TIMEOUT_MS = 5_000; // 업그레이드 fetch 가 매달리면 여기서 끊는다 (감사 A14)
const FEED_BACKOFF_MAX_MS = 60_000; // WS 재연결 지수 백오프 상한 (1초 → 60초)
const ALARM_RECHECK_MS = 60_000; // 알람 생존 확인 주기 (요청마다 스토리지를 읽지 않되, 죽은 알람은 1분 안에 되살린다 — 감사 A4)
const ACCT_PREFIX = 'acct:';

export type FeedKind = 'ws' | 'rest' | 'none';

export interface PricesResponse {
  prices: Partial<Record<Symbol, Price>>;
  feed: FeedKind;
  serverTime: number;
}

interface TickerMsg {
  group?: string;
  data?: { symbol?: string; last_price?: string; mark_price?: string; index_price?: string; range?: string };
  action?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** WS 업그레이드 fetch 에 연결 시간 상한만 건다. AbortSignal.timeout 을 그대로 넘기면 연결이 된 뒤에도 타이머가 터지며 소켓이 끊긴다(배포 직후 5초마다 재연결 관측) — 응답이 오면 타이머를 해제한다 */
async function fetchUpgrade(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { headers: { Upgrade: 'websocket' }, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export class PaperEngine extends DurableObject<Env> {
  private prices: Partial<Record<Symbol, Price>> = {};
  private feed: FeedKind = 'none';
  private ws: WebSocket | null = null;
  private lastMsgAt = 0;
  private connecting: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private accounts = new Map<number, PaperAccount>();
  private loaded: Promise<void> | null = null;
  private feedEnabled: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.feedEnabled = env.PAPER_FEED !== 'off';
  }

  // ---------------- HTTP 라우트 (워커 → DO) ----------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      await this.ensureFeed();
      switch (url.pathname) {
        case '/prices':
          return json(this.pricesResponse());
        case '/__test/prices': {
          // 테스트 전용: 피드가 꺼져 있을 때만 시세 주입 허용
          if (this.feedEnabled) return json({ error: 'not found' }, 404);
          const b = (await request.json()) as Partial<Record<Symbol, number>>;
          const now = Date.now();
          for (const s of SYMBOLS) if (b[s]) this.prices[s] = { last: b[s]!, mark: b[s]!, updatedAt: now };
          await this.runTriggers();
          return json({ ok: true });
        }
        case '/state': {
          const userId = Number(url.searchParams.get('userId'));
          const acc = await this.account(userId);
          // lite=1 이면 히스토리 제외 (3초 폴링이 매번 100건을 실어 나르지 않게)
          const lite = url.searchParams.get('lite') === '1';
          return json({ wallet: toWallet(acc, this.prices), positions: toPositions(acc, this.prices), history: lite ? [] : acc.history, ...this.pricesResponse() });
        }
        case '/open': {
          const b = (await request.json()) as { userId: number; req: OpenOrderRequest; contracts: number; contract: ContractInfo };
          const acc = await this.account(b.userId);
          const price = this.freshMark(b.req.symbol); // 마크가 기준 체결 (last_price 는 644달러 같은 이상 체결이 섞인다)
          const result = openPosition(acc, b.req, b.contracts, b.contract, price);
          await this.persist(b.userId, acc);
          return json(result);
        }
        case '/close': {
          const b = (await request.json()) as { userId: number; symbol: Symbol };
          const acc = await this.account(b.userId);
          const ev = closePosition(acc, b.symbol, this.freshMark(b.symbol), 'close');
          await this.persist(b.userId, acc);
          return json({ ok: true, contracts: ev.contracts, pnl: ev.pnl ?? 0, fee: ev.fee ?? 0 });
        }
        case '/reduce': {
          // 부분 정리 (카피 트레이딩 reduce). 보유량 이상이면 전량 정리
          const b = (await request.json()) as { userId: number; symbol: Symbol; contracts: number };
          const acc = await this.account(b.userId);
          const ev = reducePosition(acc, b.symbol, Number(b.contracts), this.freshMark(b.symbol));
          await this.persist(b.userId, acc);
          return json({ ok: true, contracts: ev.contracts, pnl: ev.pnl ?? 0, fee: ev.fee ?? 0 });
        }
        case '/tpsl': {
          const b = (await request.json()) as { userId: number; req: UpdateTpSlRequest };
          const acc = await this.account(b.userId);
          updateTpSl(acc, b.req);
          await this.persist(b.userId, acc);
          return json({ ok: true });
        }
        case '/leverage': {
          const b = (await request.json()) as { userId: number; symbol: Symbol; leverage: number };
          const acc = await this.account(b.userId);
          setLeverage(acc, b.symbol, Number(b.leverage));
          await this.persist(b.userId, acc);
          return json({ ok: true });
        }
        case '/reset': {
          const b = (await request.json()) as { userId: number };
          const acc = await this.account(b.userId);
          resetAccount(acc, this.startBalance());
          await this.persist(b.userId, acc);
          return json({ ok: true });
        }
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code, detail: e.detail }, e.status);
      log.error('PaperEngine error', e);
      return json({ error: '연습 엔진에 문제가 생겼어요', code: 'PAPER_ENGINE' }, 500);
    }
  }

  private pricesResponse(): PricesResponse {
    return { prices: this.prices, feed: this.feed, serverTime: Date.now() };
  }

  private startBalance(): number {
    return numVar(this.env.PAPER_START_BALANCE, 1000);
  }

  // ---------------- 계좌 저장소 ----------------
  private async loadAll(): Promise<void> {
    if (!this.loaded) {
      // 실패한 적재는 캐시하지 않는다 — 거부된 Promise 가 남으면 이 객체가 살아 있는 동안 모든 계좌 요청이 영구 실패 (감사 A4)
      this.loaded = (async () => {
        const map = await this.ctx.storage.list<PaperAccount>({ prefix: ACCT_PREFIX });
        for (const [k, v] of map) this.accounts.set(Number(k.slice(ACCT_PREFIX.length)), v);
      })().catch((e) => { this.loaded = null; throw e; });
    }
    await this.loaded;
  }

  private async account(userId: number): Promise<PaperAccount> {
    if (!Number.isInteger(userId) || userId <= 0) throw new HttpError(400, '사용자 정보가 올바르지 않아요', 'BAD_USER');
    await this.loadAll();
    let acc = this.accounts.get(userId);
    if (!acc) {
      acc = newAccount(this.startBalance());
      this.accounts.set(userId, acc);
      await this.persist(userId, acc);
    }
    return acc;
  }

  private async persist(userId: number, acc: PaperAccount): Promise<void> {
    await this.ctx.storage.put(ACCT_PREFIX + userId, acc);
  }

  // ---------------- 시세 피드 ----------------
  private alarmCheckedAt = 0;
  private restInflight: Promise<void> | null = null;
  private feedFailures = 0;
  private nextFeedAttemptAt = 0;
  /** 시세가 30초 이상 오래됐으면 0 (주문 거부용). 마크가 기준 */
  private freshMark(symbol: Symbol): number {
    const p = this.prices[symbol];
    if (!p || Date.now() - p.updatedAt > STALE_MS) return 0;
    return p.mark > 0 ? p.mark : p.last;
  }
  private async ensureFeed(): Promise<void> {
    if (!this.feedEnabled) return;
    // 알람 확인은 1분에 1회 (요청마다 스토리지를 읽으면 모든 요청이 그 뒤로 직렬화된다). 크론이 매분 /prices 를 불러 죽은 알람을 되살린다
    if (Date.now() - this.alarmCheckedAt >= ALARM_RECHECK_MS) {
      this.alarmCheckedAt = Date.now();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    this.connectIfDue();
    // 콜드 스타트: WS 첫 틱 전에도 시세가 있도록 REST 로 한 번 채운다. 동시 요청은 한 번의 호출을 공유
    if (Object.keys(this.prices).length === 0) await (this.restInflight ??= this.pollRest().finally(() => (this.restInflight = null)));
  }

  /** 워치독: DO 가 잠들었다 깨어나도 알람이 다시 연결·판정을 돌린다. */
  async alarm(): Promise<void> {
    if (!this.feedEnabled) return;
    const now = Date.now();
    let healthy = false;
    try {
      healthy = this.ws !== null && now - this.lastMsgAt < STALE_MS;
      if (!healthy) {
        if (this.ws) this.dropSocket();
        this.connectIfDue();
        await this.pollRest();
      }
      await this.runTriggers();
    } catch (e) {
      log.error('paper alarm failed', { message: (e as Error).message });
    } finally {
      // 예외 1회로 알람이 죽지 않게 항상 다시 건다 (감사 A4). setAlarm 자체가 실패하면 다음 /prices(크론 매분)가 되살린다
      await this.ctx.storage.setAlarm(now + (this.ws && healthy ? ALARM_HEALTHY_MS : ALARM_POLL_MS)).catch((e) => { this.alarmCheckedAt = 0; log.error('paper alarm re-arm failed', { message: (e as Error).message }); });
    }
  }

  /** 백오프 시각이 지났고 연결 중이 아니면 WS 연결 시도 (기다리지 않는다). 실패마다 1초→60초로 늘고, 메시지를 받으면 초기화 (감사 A14) */
  private connectIfDue(): void {
    if (this.ws || this.connecting || Date.now() < this.nextFeedAttemptAt) return;
    this.connecting = this.connectFeed().finally(() => (this.connecting = null));
  }

  private async connectFeed(): Promise<void> {
    try {
      const res = await fetchUpgrade(WOOX_WS_URL, WS_CONNECT_TIMEOUT_MS);
      const ws = res.webSocket;
      if (!ws) throw new Error(`upgrade failed: HTTP ${res.status}`);
      ws.accept();
      this.ws = ws;
      this.lastMsgAt = Date.now();
      ws.send(JSON.stringify({ action: 'subscribe', args: SYMBOLS.map((s) => `futures/ticker:${s}`) }));
      ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
      ws.addEventListener('close', () => this.dropSocket());
      ws.addEventListener('error', () => this.dropSocket());
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && Date.now() - this.lastMsgAt > PING_AFTER_MS) {
          try {
            this.ws.send(JSON.stringify({ action: 'ping' }));
          } catch {
            this.dropSocket();
          }
        }
      }, 5000);
      log.info('paper feed: websocket connected');
    } catch (e) {
      this.ws = null;
      this.feedFailures++;
      this.nextFeedAttemptAt = Date.now() + Math.min(FEED_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(this.feedFailures - 1, 6));
      log.warn('paper feed: websocket connect failed, falling back to REST', { failures: this.feedFailures, message: (e as Error).message });
    }
  }

  private dropSocket(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.feed === 'ws') this.feed = 'none';
  }

  private onMessage(raw: string): void {
    this.lastMsgAt = Date.now();
    this.feedFailures = 0;   // 메시지가 오면 연결이 살아 있는 것 → 백오프 초기화
    this.nextFeedAttemptAt = 0;
    let msg: TickerMsg;
    try {
      msg = JSON.parse(raw) as TickerMsg;
    } catch {
      return;
    }
    const d = msg.data;
    if (!d || !msg.group?.startsWith('futures/ticker:')) return;
    const symbol = d.symbol as Symbol;
    if (!(SYMBOLS as string[]).includes(symbol)) return;
    const rawLast = Number(d.last_price);
    const mark = Number(d.mark_price);
    if (!(mark > 0) && !(rawLast > 0)) return;
    // 마크가와 5% 넘게 벌어진 last 는 이상 체결(예: 644달러)로 보고 마크가로 대체
    const base = mark > 0 ? mark : rawLast;
    const last = rawLast > 0 && Math.abs(rawLast / base - 1) < 0.05 ? rawLast : base;
    // range = 24시간 등락률(소수, 예: -0.0066 → -0.66%). 실측 2026-09-07.
    const range = Number(d.range);
    this.prices[symbol] = {
      last,
      mark: base,
      change24hPct: Number.isFinite(range) ? Number((range * 100).toFixed(2)) : undefined,
      updatedAt: this.lastMsgAt,
    };
    this.feed = 'ws';
    void this.runTriggers().catch((e) => log.warn('paper triggers failed', { message: (e as Error).message }));
  }

  /** REST 폴백: /contract/public/details 의 index_price 를 last/mark 로 사용 (last_price 는 실측상 신뢰 불가). */
  private async pollRest(): Promise<void> {
    try {
      const list = await new WooxClient({ timeoutMs: 5000 }).getContractDetails();
      const now = Date.now();
      for (const d of list) {
        if (!(SYMBOLS as string[]).includes(d.symbol)) continue;
        const idx = Number(d.index_price);
        if (!(idx > 0)) continue;
        // change_24h 는 실측상 비정상(-0.99 = -99%)이라 쓰지 않는다. 등락률은 WS 티커의 range 로만 채운다.
        const prev = this.prices[d.symbol as Symbol];
        this.prices[d.symbol as Symbol] = { last: idx, mark: idx, change24hPct: prev?.change24hPct, updatedAt: now };
      }
      if (this.feed !== 'ws') this.feed = 'rest';
    } catch (e) {
      log.warn('paper feed: REST poll failed', { message: (e as Error).message });
    }
  }

  private triggerRunning = false;
  private async runTriggers(): Promise<void> {
    if (this.triggerRunning) return;
    this.triggerRunning = true;
    try {
      await this.loadAll();
      const last: Partial<Record<Symbol, number>> = {};
      for (const s of SYMBOLS) if (this.prices[s]) last[s] = this.prices[s]!.mark || this.prices[s]!.last; // 손절/익절/강제정리 판정은 마크가
      const writes: Promise<void>[] = [];
      for (const [userId, acc] of this.accounts) {
        if (acc.positions.length === 0) continue;
        const evs = checkTriggers(acc, last);
        if (evs.length) {
          log.info('paper trigger', { userId, events: evs.map((e) => `${e.type}:${e.symbol}@${e.price}`) });
          writes.push(this.persist(userId, acc));
        }
      }
      await Promise.all(writes);
    } finally {
      this.triggerRunning = false;
    }
  }
}
