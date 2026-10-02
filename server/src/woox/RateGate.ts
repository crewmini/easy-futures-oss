// 거래소 요청 관문 — 서버 전체(모든 사용자 키)의 사설 REST 호출을 한곳에서 세어, 거래소가 우리 IP/브로커 단위로 거는 공용 한도를 넘기지 않게 한다.
// 실측(2026-10-02 17:45): 키별 한도와 무관하게 세 사용자가 주문 제출·포지션·잔고에서 동시에 429 → 키 밖의 공용 한도가 존재.
// 버킷(경로 마지막 조각)별 2초 창 슬롯을 나눠 주고, 꽉 찼으면 "몇 ms 뒤에 보내라"를 돌려준다 (호출자는 그만큼 기다렸다 보낸다).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { log } from '../log.js';

export const GATE_WINDOW_MS = 2_000;
/** 2초 창당 전체 허용 횟수 — 키별 한도의 약 2배에서 시작, 429 로그를 보며 조정 (RATE_LIMITS 환경변수 JSON 으로 덮어쓸 수 있다) */
export const DEFAULT_GATE_LIMITS: Record<string, number> = { 'position-v2': 14, 'assets-detail': 14, 'submit-order': 12, 'current-plan-order': 40, 'order': 24, 'order-history': 8, 'trades': 8, 'submit-leverage': 12, 'submit-tp-sl-order': 20, 'modify-tp-sl-order': 20, 'cancel-plan-order': 20, '*': 24 };
export const GATE_MAX_WAIT_MS = 6_000;   // 이보다 오래 기다려야 하면 그냥 보낸다 (관문이 병목이 되지 않게)

export function gateBucket(path: string): string {
  return path.split('?')[0].split('/').filter(Boolean).pop() ?? '*';
}

export class RateGate extends DurableObject<Env> {
  private slots = new Map<string, number[]>();   // 버킷 → 배정된 발송 시각들 (창 안의 것만 유지)
  private limits: Record<string, number> | null = null;

  private limitOf(bucket: string): number {
    if (!this.limits) {
      this.limits = { ...DEFAULT_GATE_LIMITS };
      try { if (this.env.RATE_LIMITS) Object.assign(this.limits, JSON.parse(this.env.RATE_LIMITS) as Record<string, number>); } catch { log.warn('RATE_LIMITS 환경변수 JSON 오류 — 기본값 사용'); }
    }
    return this.limits[bucket] ?? this.limits['*'] ?? 24;
  }

  /** 슬롯 하나 배정: 지금 보낼 수 있으면 0, 아니면 기다릴 ms. 배정된 시각을 창에 기록해 다음 호출자가 그 뒤로 밀린다 */
  take(bucket: string, now = Date.now()): number {
    const limit = this.limitOf(bucket);
    const arr = (this.slots.get(bucket) ?? []).filter((t) => now - t < GATE_WINDOW_MS);
    let at = now;
    if (arr.length >= limit) {
      // 가장 오래된 슬롯이 창을 벗어나는 순간 + 여유 10ms. 이미 미래로 밀린 슬롯이 있으면 그 뒤로
      const sorted = [...arr].sort((a, b) => a - b);
      at = Math.max(now, sorted[sorted.length - limit] + GATE_WINDOW_MS + 10);
    }
    arr.push(at);
    this.slots.set(bucket, arr);
    return Math.min(GATE_MAX_WAIT_MS, at - now);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/take') {
      const { bucket } = (await request.json().catch(() => ({}))) as { bucket?: string };
      return Response.json({ wait: this.take(bucket || '*') });
    }
    if (url.pathname === '/status') {
      const now = Date.now();
      return Response.json(Object.fromEntries([...this.slots].map(([b, arr]) => [b, { used: arr.filter((t) => now - t < GATE_WINDOW_MS).length, limit: this.limitOf(b) }])));
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

/** WooxClient 에 꽂는 관문 함수. DO 호출 실패 시에는 기다리지 않고 그냥 보낸다 (관문 장애가 거래를 막지 않게) */
export function makeRateGate(env: Env): (path: string) => Promise<void> {
  if (!env.RATE) return async () => {};
  const stub = env.RATE.get(env.RATE.idFromName('global'));
  return async (path: string) => {
    try {
      const r = await stub.fetch('https://rate/take', { method: 'POST', body: JSON.stringify({ bucket: gateBucket(path) }), headers: { 'content-type': 'application/json' } });
      const { wait } = (await r.json()) as { wait?: number };
      if (wait && wait > 0) await new Promise((res) => setTimeout(res, wait));
    } catch (e) {
      log.warn('rate gate unavailable — sending without gate', { message: (e as Error).message });
    }
  };
}
