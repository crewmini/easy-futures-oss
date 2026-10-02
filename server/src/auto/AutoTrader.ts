// 자동매매 실행기 (Durable Object, 싱글턴): 신호 1건을 자동매매 사용자 전원에게 실행한다.
// 사용자마다 본인 키(실거래) 또는 연습 엔진으로, 동시 8명씩. 결과는 auto_executions 에 남긴다.
import { DurableObject } from 'cloudflare:workers';
import { calcContracts, priceAtRoi, roundToPrecision, SYMBOLS, type AutoSettings, type AutoSignal, type OpenOrderRequest } from '@easy-futures/shared';
import { WooxAdapter } from '../adapters/woox.js';
import { PaperAdapter } from '../adapters/paper.js';
import type { BrokerAdapter } from '../adapters/types.js';
import { getCredsForUser, getSettings } from '../db.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { WooxClient } from '../woox/client.js';
import { disableAuto, executedUserIds, finishSignal, getSignal, insertExecution, listFollowers } from './db.js';
import { WooxError } from '../woox/client.js';
import { estimateLiquidation } from '@easy-futures/shared';

const MARK_FRESH_MS = 30_000;
const DEFAULT_SIGNAL_LEVERAGE = 3;   // 신호에 배율이 없을 때 (관리자 수동 신호 등) — 사용자 최대가 아니라 보수적으로

/** 거래소·네트워크 오류를 어르신이 읽을 수 있는 한 줄로 (원문은 로그에만) */
export function humanizeError(e: unknown): string {
  if (e instanceof WooxError) {
    if (e.httpStatus === 401 || e.httpStatus === 403 || /signature|api ?key|permission|auth/i.test(String(e.message))) return 'API 키가 거절됐어요 — 설정에서 키를 다시 등록하세요';
    if (e.httpStatus === 429) return `거래소가 잠시 바빠요 (${String(e.path ?? '').split('/').pop() || '요청 한도'}) — 다음 신호에 다시 시도돼요`;
    if (/balance|insufficient|margin/i.test(String(e.message))) return '거래소 잔고가 부족해요';
    if (/precision|size|volume/i.test(String(e.message))) return '주문 수량이 거래소 규칙에 맞지 않아요';
    return `거래소가 주문을 거절했어요 (${e.code}${e.message ? `: ${String(e.message).slice(0, 70)}` : ''})`;   // 원문을 남긴다 — 코드만으로는 원인을 알 수 없다 (교훈 2026-09-21)
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/네트워크|timeout|abort|fetch/i.test(msg)) return '거래소 응답이 없어요 — 다음 신호에 다시 시도돼요';
  return msg.length > 80 ? '실행 중 오류가 났어요' : msg;
}

// 팬아웃: 코디네이터(global)가 팔로워를 SHARD_SIZE 명씩 잘라 샤드 DO 인스턴스(shard-N)에 동시에 던진다.
// Worker 한 실행당 동시 연결이 6개로 제한되므로, 한 인스턴스 안에서 동시성을 올리는 대신 인스턴스를 늘려
// 전체 시간이 "한 사람 주문 시간"에 수렴하게 한다. 샤드 3명 × (계좌 조회 2 병렬 + 주문) ≈ 연결 6개.
const SHARD_SIZE = 3;
const MAX_SHARDS_IN_FLIGHT = 120;   // 360명까지 한 번에

type ExecResult = { status: 'ok' | 'failed' | 'skipped'; detail: string | null; orderId: string | null; mode: 'paper' | 'live' };
interface ShardRequest { signalId: string; followers: { userId: number; settings: AutoSettings }[]; mark: number }
interface Counts { ok: number; fail: number; skipped: number }

export class AutoTrader extends DurableObject<Env> {
  private running = new Set<string>();
  /** 종목별로 신호를 순서대로 실행 — 진입 팬아웃이 끝나기 전에 정리/본절이 먼저 돌아 "정리할 포지션 없음"으로 빠지는 경합 방지 (감사 M3) */
  private symbolQueue = new Map<string, Promise<unknown>>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const { signalId } = (await request.json()) as { signalId: string };
      if (this.running.has(signalId)) return Response.json({ ok: true, dup: true, followers: 0, ok_: 0, fail: 0, skipped: 0 });
      this.running.add(signalId);
      try {
        const signal = await getSignal(this.env.DB, signalId);
        const key = signal?.symbol ?? '*';
        const prev = this.symbolQueue.get(key) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(() => this.runSignal(signalId));
        this.symbolQueue.set(key, run);
        const result = await run;
        if (this.symbolQueue.get(key) === run) this.symbolQueue.delete(key);
        return Response.json(result);
      } finally { this.running.delete(signalId); }
    }
    if (url.pathname === '/run-shard' && request.method === 'POST') {
      return Response.json(await this.runShard((await request.json()) as ShardRequest));
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  private async runSignal(signalId: string): Promise<{ followers: number; ok: number; fail: number; skipped: number; ms: number }> {
    const env = this.env;
    const t0 = Date.now();
    const signal = await getSignal(env.DB, signalId);
    if (!signal) return { followers: 0, ok: 0, fail: 0, skipped: 0, ms: 0 };
    if (signal.processedAt) return { followers: signal.followerCount ?? 0, ok: signal.okCount ?? 0, fail: signal.failCount ?? 0, skipped: 0, ms: 0 };
    const done = await executedUserIds(env.DB, signalId); // 재실행(관리자 rerun)·샤드 장애 뒤: 이미 기록된 사용자는 건너뜀
    const followers = (await listFollowers(env.DB)).filter((f) => !done.has(f.userId));
    const pr = await new PaperClient(env).prices();
    const px = pr.prices[signal.symbol];
    const mark = px?.mark || px?.last || 0;
    log.info('auto signal start', { signalId, action: signal.action, symbol: signal.symbol, followers: followers.length, alreadyDone: done.size });
    // 시세가 30초 넘게 오래됐으면(시세 연결 끊김) 실행하지 않는다 — 옛 가격으로 지정가·손절을 잡으면 체결 실패나 엉뚱한 손절이 된다 (감사 M9)
    if (signal.action !== 'close' && (!(mark > 0) || !px || Date.now() - px.updatedAt > MARK_FRESH_MS)) {
      for (const f of followers) await insertExecution(env.DB, signalId, f.userId, 'paper', 'failed', '시세가 오래돼 실행하지 않았어요 (시세 연결 확인 필요)', null).catch(() => {});
      await finishSignal(env.DB, signalId, followers.length + done.size, 0, followers.length, 0);
      log.error('auto signal aborted: stale mark', { signalId, symbol: signal.symbol, updatedAt: px?.updatedAt ?? null });
      return { followers: followers.length, ok: 0, fail: followers.length, skipped: 0, ms: Date.now() - t0 };
    }

    const shards: ShardRequest[] = [];
    for (let i = 0; i < followers.length; i += SHARD_SIZE) shards.push({ signalId, followers: followers.slice(i, i + SHARD_SIZE), mark });
    const totals: Counts = { ok: 0, fail: 0, skipped: 0 };
    // 샤드를 MAX_SHARDS_IN_FLIGHT 개씩 동시에. 샤드 호출 자체가 실패하면 그 샤드 사용자는 전부 실패로 기록
    for (let i = 0; i < shards.length; i += MAX_SHARDS_IN_FLIGHT) {
      const batch = shards.slice(i, i + MAX_SHARDS_IN_FLIGHT);
      const results = await Promise.all(batch.map(async (sh, k) => {
        const stub = env.AUTO.get(env.AUTO.idFromName(`shard-${i + k}`));
        try {
          const r = await stub.fetch('https://auto/run-shard', { method: 'POST', body: JSON.stringify(sh), headers: { 'content-type': 'application/json' } });
          if (r.status === 404) return this.runShard(sh); // 배포 직후 옛 코드가 남은 샤드 — 코디네이터가 직접 실행
          if (!r.ok) throw new Error(`shard http ${r.status}`);
          return (await r.json()) as Counts;
        } catch (e) {
          log.error('auto shard failed', e);
          // 샤드가 일부 사용자를 이미 기록했을 수 있다 — OR IGNORE 라 실제 결과가 덮이지 않는다
          for (const f of sh.followers) await insertExecution(env.DB, signalId, f.userId, 'paper', 'failed', '실행기 오류 — 담당자에게 문의하세요', null).catch((err) => log.error('execution insert failed', err));
          return { ok: 0, fail: sh.followers.length, skipped: 0 };
        }
      }));
      for (const c of results) { totals.ok += c.ok; totals.fail += c.fail; totals.skipped += c.skipped; }
    }
    await finishSignal(env.DB, signalId, followers.length + done.size, totals.ok, totals.fail, totals.skipped);
    const ms = Date.now() - t0;
    log.info('auto signal done', { signalId, ...totals, followers: followers.length, ms, shards: shards.length });
    return { followers: followers.length, ...totals, ms };
  }

  /** 샤드: 자기 몫의 사용자를 전부 동시에 실행하고 결과를 기록 */
  private async runShard(req: ShardRequest): Promise<Counts> {
    const env = this.env;
    const signal = await getSignal(env.DB, req.signalId);
    if (!signal) return { ok: 0, fail: req.followers.length, skipped: 0 };
    const paper = new PaperClient(env);
    const contracts = await getContracts();
    const counts: Counts = { ok: 0, fail: 0, skipped: 0 };
    await Promise.all(req.followers.map(async (f) => {
      const seen = { mode: 'paper' as 'paper' | 'live' };
      const r: ExecResult = await this.executeFor(f.userId, f.settings, signal, req.mark, contracts, paper, (m) => { seen.mode = m; }).catch((e) => {
        log.warn('auto execution failed', { signalId: req.signalId, userId: f.userId, message: (e as Error).message });
        return { status: 'failed' as const, detail: humanizeError(e), orderId: null, mode: seen.mode };
      });
      const mode = seen.mode;
      if (r.status === 'ok') counts.ok++; else if (r.status === 'failed') counts.fail++; else counts.skipped++;
      await insertExecution(env.DB, req.signalId, f.userId, r.mode, r.status, r.detail, r.orderId).catch((err) => log.error('execution insert failed', { signalId: req.signalId, userId: f.userId, message: (err as Error).message }));
      // 실거래 키 거절(401류)이면 자동매매를 끄고 사유를 남긴다 — 신호마다 같은 실패가 반복되지 않게 (감사 M7)
      if (r.status === 'failed' && mode === 'live' && /API 키가 거절/.test(r.detail ?? '')) await disableAuto(env.DB, f.userId, 'API 키가 거절돼 AI 자동매매를 껐어요. 설정에서 키를 다시 등록한 뒤 켜 주세요').catch(() => {});
      if (r.status === 'skipped' && mode === 'live' && r.detail === 'API 키 없음') await disableAuto(env.DB, f.userId, 'API 키가 없어 AI 자동매매를 껐어요. 설정에서 키를 등록한 뒤 켜 주세요').catch(() => {});
    }));
    return counts;
  }

  private async executeFor(userId: number, s: AutoSettings, signal: AutoSignal, mark: number, contracts: Awaited<ReturnType<typeof getContracts>>, paper: PaperClient, onMode?: (m: 'paper' | 'live') => void) {
    const settings = await getSettings(this.env, userId);
    const mode = settings.mode;
    onMode?.(mode);
    let adapter: BrokerAdapter;
    if (mode === 'live') {
      const creds = await getCredsForUser(this.env, userId);
      if (!creds) return { status: 'skipped' as const, detail: 'API 키 없음', orderId: null, mode };
      adapter = new WooxAdapter(new WooxClient({ credentials: creds, gate: makeRateGate(this.env) }));
    } else {
      adapter = new PaperAdapter(paper, userId);
    }
    const contract = contracts[signal.symbol];
    if (signal.action === 'close') {
      try { await adapter.closePosition(signal.symbol, contract); return { status: 'ok' as const, detail: '정리', orderId: null, mode }; }
      catch (e) {
        const msg = (e as Error).message;
        if (/포지션이 없어요/.test(msg)) return { status: 'skipped' as const, detail: '정리할 포지션 없음', orderId: null, mode };
        throw e;
      }
    }
    if (!(mark > 0)) return { status: 'failed' as const, detail: '시세 없음', orderId: null, mode };
    if (signal.action === 'update') {
      // 손절/익절 갱신 (본절 포함). 포지션이 있는 사용자만
      const acc0 = await adapter.getAccount(contracts, { [signal.symbol]: { last: mark, mark, updatedAt: Date.now() } });
      const pos = acc0.positions.find((p) => p.symbol === signal.symbol);
      if (!pos) return { status: 'skipped' as const, detail: '갱신할 포지션 없음', orderId: null, mode };
      const upd: { symbol: typeof signal.symbol; stopLossPrice?: number | null; takeProfitPrice?: number | null } = { symbol: signal.symbol };
      const isLong = pos.direction === 'long';
      const okSl = (v: number) => (isLong ? v < mark : v > mark);
      const okTp = (v: number) => (isLong ? v > mark : v < mark);
      if (signal.breakeven) {
        // 이익 중이면 손절을 평단으로(본전 보장), 손실 중이면 익절을 평단으로(본전 오면 나가기)
        const entry = roundToPrecision(pos.entryPrice, contract.pricePrecision);
        if (okSl(entry)) upd.stopLossPrice = entry; else if (okTp(entry)) upd.takeProfitPrice = entry;
        else return { status: 'skipped' as const, detail: '평단이 지금 가격과 같아 본절 설정 불가', orderId: null, mode };
      }
      if (signal.slPrice != null) { const v = roundToPrecision(signal.slPrice, contract.pricePrecision); if (okSl(v)) upd.stopLossPrice = v; else return { status: 'skipped' as const, detail: `손절가 ${v}가 지금 가격을 지나쳐 적용 불가`, orderId: null, mode }; }
      else if (signal.slRoi != null) { const v = roundToPrecision(priceAtRoi(pos.entryPrice, signal.slRoi, pos.leverage, pos.direction, 'sl'), contract.pricePrecision); if (okSl(v)) upd.stopLossPrice = v; }
      if (signal.tpPrice != null) { const v = roundToPrecision(signal.tpPrice, contract.pricePrecision); if (okTp(v)) upd.takeProfitPrice = v; else return { status: 'skipped' as const, detail: `익절가 ${v}가 지금 가격을 지나쳐 적용 불가`, orderId: null, mode }; }
      else if (signal.tpRoi != null) { const v = roundToPrecision(priceAtRoi(pos.entryPrice, signal.tpRoi, pos.leverage, pos.direction, 'tp'), contract.pricePrecision); if (okTp(v)) upd.takeProfitPrice = v; }
      if (upd.stopLossPrice === undefined && upd.takeProfitPrice === undefined) return { status: 'skipped' as const, detail: '적용할 값 없음', orderId: null, mode };
      await adapter.updateTpSl(upd, contract);
      return { status: 'ok' as const, detail: `${upd.stopLossPrice !== undefined ? `손절 ${upd.stopLossPrice}` : ''}${upd.stopLossPrice !== undefined && upd.takeProfitPrice !== undefined ? ' · ' : ''}${upd.takeProfitPrice !== undefined ? `익절 ${upd.takeProfitPrice}` : ''}${signal.breakeven ? ' (본절)' : ''}`, orderId: null, mode };
    }
    // open / add (같은 방향이면 물량 합산·평단 재계산)
    const direction = signal.direction ?? 'long';
    const wanted = signal.leverage ?? DEFAULT_SIGNAL_LEVERAGE; // 신호에 배율이 없으면 보수적으로 (사용자 최대가 아님 — 감사 M8)
    const leverage = Math.max(1, Math.min(wanted, s.maxLeverage, settings.maxLeverage, contract.maxLeverage));
    const levNote = leverage !== wanted ? ` (배율 ${wanted}→${leverage})` : '';
    const acc = await adapter.getAccount(contracts, { [signal.symbol]: { last: mark, mark, updatedAt: Date.now() } });
    const existing = acc.positions.find((p) => p.symbol === signal.symbol);
    if (existing && existing.direction !== direction) return { status: 'skipped' as const, detail: '반대 방향 포지션 보유 중', orderId: null, mode };
    const rawAmount = Math.floor(acc.wallet.available * (s.pct / 100) * 100) / 100;
    if (!(rawAmount > 0)) return { status: 'skipped' as const, detail: '쓸 수 있는 돈 없음', orderId: null, mode };
    const amountUsdt = Math.min(rawAmount, settings.maxAmountUsdt); // 1회 최대 금액은 건너뛰지 않고 그 금액으로 (감사 M12)
    const capNote = amountUsdt < rawAmount ? ` (1회 최대 ${settings.maxAmountUsdt} USDT 로 제한)` : '';
    // 손절 필수: 절대가(직전 저점) > 내 돈 기준 % > 사용자 기본값 순. 절대가가 지금 가격을 지나쳤으면 % 로 대체
    const slRoi = signal.slRoi ?? s.defaultSlRoi;
    let sl = roundToPrecision(priceAtRoi(mark, slRoi, leverage, direction, 'sl'), contract.pricePrecision);
    let slNote = '';
    if (signal.slPrice != null) {
      const v = roundToPrecision(signal.slPrice, contract.pricePrecision);
      // 봇이 준 손절가(저점)를 이미 지나쳤다 = 저점이 깨진 뒤의 진입 → 전략상 무효. 대체 손절로 들어가지 않고 건너뛴다 (감사 H3)
      if (direction === 'long' ? v < mark : v > mark) sl = v;
      else return { status: 'skipped' as const, detail: `손절가 ${v}를 지금 가격(${mark})이 이미 지나쳐 진입하지 않았어요`, orderId: null, mode };
    }
    // 손절이 강제정리 가격 밖이면 손절이 없는 것과 같다 → 내 돈 기준 기본 손절로 대체 (감사 H6)
    const liq = estimateLiquidation(mark, leverage, direction);
    if (direction === 'long' ? sl <= liq : sl >= liq) {
      sl = roundToPrecision(priceAtRoi(mark, Math.min(slRoi, 80), leverage, direction, 'sl'), contract.pricePrecision);
      slNote = ` (지정 손절가가 강제정리 밖이라 내 돈 기준 -${Math.min(slRoi, 80)}% 손절 적용)`;
    }
    const tpRoi = signal.tpRoi ?? null;
    let tp = tpRoi ? roundToPrecision(priceAtRoi(mark, tpRoi, leverage, direction, 'tp'), contract.pricePrecision) : null;
    if (signal.tpPrice != null) { const v = roundToPrecision(signal.tpPrice, contract.pricePrecision); if (direction === 'long' ? v > mark : v < mark) tp = v; }
    const n = calcContracts(amountUsdt, leverage, mark, contract);
    if (n <= 0) {
      const need = Math.ceil((contract.minVolume * contract.contractSize * mark / leverage) * 100) / 100;
      return { status: 'skipped' as const, detail: `금액이 너무 적음 — 1계약에 내 돈 ${need} USDT 필요 (지금 ${amountUsdt} USDT)`, orderId: null, mode };
    }
    // 절대 손절가를 쓰는 경우 체결 후 재정렬(ROI 기준)을 하지 않도록 ROI 를 넘기지 않는다
    const usedAbsSl = signal.slPrice != null && sl === roundToPrecision(signal.slPrice, contract.pricePrecision);
    const req: OpenOrderRequest = { symbol: signal.symbol, direction, amountUsdt, leverage, stopLossPrice: sl, takeProfitPrice: tp, stopLossRoiPct: usedAbsSl ? null : slRoi, takeProfitRoiPct: signal.tpPrice != null ? null : tpRoi };
    const r = await adapter.openOrder(req, n, contract, mark);
    const label = signal.action === 'add' ? (existing ? '불타기 ' : '신규 진입(불타기 신호) ') : '';
    const usedMargin = Math.round((n * contract.contractSize * mark / leverage) * 100) / 100; // 실제로 쓰인 증거금(계약 수 내림 반영) — 감사 M2
    return { status: 'ok' as const, detail: `${label}${direction === 'long' ? '오른다' : '내린다'} ${usedMargin} USDT ${leverage}배 (${n}계약) · 손절 ${sl}${tp ? ` · 익절 ${tp}` : ''}${slNote}${levNote}${capNote}`, orderId: r.orderId, mode };
  }
}
export const AUTO_SYMBOLS = SYMBOLS;
