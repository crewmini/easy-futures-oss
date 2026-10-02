// 카피 트레이딩 전 흐름 (workerd 안, 연습 마스터 + 연습 팔로워): 감시 폴링 → 이벤트 → 팬아웃 → 장부/실현손익, 손절·익절·배율 복제, 손실 한도, 킥/알람
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { calcContracts, COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION, type CopyFollowSettings, type Symbol } from '@easy-futures/shared';
import { createUser, saveSettings } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { FALLBACK_CONTRACTS } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { addRealizedPnl, applyMaster, claimCopyExecution, createFollow, getEvent, getFollow, getMasterState, insertEvent, listCopyPositions, listEventExecutions, listEvents, setMasterStatus } from './db.js';
import { entrySizing } from './sizing.js';
import { diffSymbol, gateShrink, kickMasters, masterStub } from './MasterWatcher.js';
import { copyStub } from './CopyTrader.js';

const ETH = FALLBACK_CONTRACTS.ETHUSDT;
const paper = () => new PaperClient(env);
const J = { 'content-type': 'application/json' };

async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
async function mkMaster(loginId: string, uid: string, approve = true) {
  const id = await mkUser(loginId, uid);
  await applyMaster(env.DB, id, loginId, '테스트 고수', MASTER_TERMS_VERSION);
  if (approve) expect(await setMasterStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
  return id;
}
const FOLLOW: CopyFollowSettings = { copyAmount: 500, lossLimitPct: 50, maxLeverage: 10, slRoi: 50 };   // slRoi 50 → 5배에서 내 손절 한도 2250 (고수 손절 2300 이 더 빡빡 → 고수 값 그대로)
const follow = (followerId: number, masterId: number, s: CopyFollowSettings = FOLLOW) => createFollow(env.DB, followerId, masterId, 'paper', s, COPY_TERMS_VERSION);
/** 시세 주입 + PaperClient 1초 캐시 만료 대기 */
async function setPrices(p: Partial<Record<Symbol, number>>) {
  await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100, ...p }) });
  await new Promise((r) => setTimeout(r, 1100));
}
async function poll(masterId: number) {
  const r = await masterStub(env, masterId).fetch('https://master/poll', { method: 'POST' });
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: boolean; events: string[]; results: Record<string, unknown>[] };
}
const status = async (masterId: number) => (await (await masterStub(env, masterId).fetch('https://master/status')).json()) as { wsOk: boolean; lastPollAt: number | null; lastError: string | null; alarm: number | null; seq: number };
const execs = async (eventId: string) => Object.fromEntries((await listEventExecutions(env.DB, eventId)).map((e) => [e.followerId, e]));
const openMaster = (masterId: number, extra: Partial<{ stopLossPrice: number; takeProfitPrice: number | null }> = {}) =>
  paper().open(masterId, { symbol: 'ETHUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 2_300, takeProfitPrice: 2_800, ...extra }, calcContracts(100, 5, 2_500, ETH), ETH);

describe('copy trading end to end (paper master + paper followers)', () => {
  it('open → tpsl → leverage → reduce → close → loss limit → follower close / check-loss', async () => {
    await setPrices({});
    const M = await mkMaster('cmaster1', '92000001');
    const F1 = await mkUser('cfol1', '92000002');
    const F2 = await mkUser('cfol2', '92000003');
    const f1 = await follow(F1, M);
    const f2 = await follow(F2, M);

    // 첫 폴링 = 기준선만 (이벤트 없음)
    let r = await poll(M);
    expect(r.events).toEqual([]);
    expect((await getMasterState(env.DB, M)).size).toBe(3);

    // F2 는 직접 반대 방향(숏) 보유 → 건너뜀
    await paper().open(F2, { symbol: 'ETHUSDT', direction: 'short', amountUsdt: 50, leverage: 2, stopLossPrice: 2_700 }, calcContracts(50, 2, 2_500, ETH), ETH);

    // 고수 진입 (손절 2300 · 익절 2800) → open 이벤트
    const masterContracts = calcContracts(100, 5, 2_500, ETH);
    expect(masterContracts).toBe(200);
    await openMaster(M);
    r = await poll(M);
    expect(r.events).toEqual([`copy-${M}-ETHUSDT-1`]);
    const ev1 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev1).toMatchObject({ kind: 'open', direction: 'long', beforeContracts: 0, afterContracts: 200, leverage: 5, slPrice: 2_300, tpPrice: 2_800, followerCount: 2, okCount: 1, skippedCount: 1 });
    expect(ev1.processedAt).not.toBeNull();
    let x = await execs(ev1.id);
    expect(x[F1].status).toBe('ok');
    expect(x[F2]).toMatchObject({ status: 'skipped', detail: '반대 방향 포지션 보유 중' });
    // 비례 크기 = entrySizing 과 일치, 손절·익절은 고수 값 그대로
    const sizing = entrySizing({ masterDelta: 200, price: ev1.price, masterLeverage: 5, masterEquity: ev1.masterEquity, copyAmountNow: 500, available: 1000, followerMaxLeverage: 10, contract: ETH });
    expect(sizing.contracts).toBe(100);
    let book = (await listCopyPositions(env.DB, F1))[0];
    expect(book).toMatchObject({ symbol: 'ETHUSDT', direction: 'long', contracts: sizing.contracts, leverage: 5, slPrice: 2_300, tpPrice: 2_800 });
    expect(x[F1].contracts).toBe(sizing.contracts);
    // 체결가 기록 → 슬리피지 (연습 엔진은 마크 = 이벤트 가격이라 0)
    expect(x[F1].fillPrice).toBe(ev1.price);
    expect(x[F1].slippagePct).toBe(0);
    let pos = (await paper().state(F1)).positions[0];
    expect(pos).toMatchObject({ contracts: 100, leverage: 5, stopLossPrice: 2_300, takeProfitPrice: 2_800 });

    // 같은 상태로 다시 폴링 → 이벤트 없음 (중복 없음)
    r = await poll(M);
    expect(r.events).toEqual([]);
    expect((await listEvents(env.DB, M)).length).toBe(1);

    // F2 가 직접 숏을 정리 (이후 이벤트는 장부가 없어 건너뜀)
    await paper().close(F2, 'ETHUSDT');

    // 고수가 손절 2350 으로 올리고 익절 해제 → tpsl 이벤트 → F1 포지션에 같은 값
    await paper().tpsl(M, { symbol: 'ETHUSDT', stopLossPrice: 2_350, takeProfitPrice: null });
    r = await poll(M);
    expect(r.events).toEqual([`copy-${M}-ETHUSDT-2`]);
    const ev2 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev2).toMatchObject({ kind: 'tpsl', slPrice: 2_350, tpPrice: null, beforeContracts: 200, afterContracts: 200 });
    x = await execs(ev2.id);
    expect(x[F1].status).toBe('ok');
    expect(x[F2]).toMatchObject({ status: 'skipped', detail: '따라 들어간 포지션 없음' });
    pos = (await paper().state(F1)).positions[0];
    expect(pos).toMatchObject({ stopLossPrice: 2_350, takeProfitPrice: null });
    book = (await listCopyPositions(env.DB, F1))[0];
    expect(book).toMatchObject({ slPrice: 2_350, tpPrice: null });

    // 고수 배율 5 → 20 → leverage 이벤트 → F1 은 상한 10 으로
    await paper().setLeverage(M, 'ETHUSDT', 20);
    r = await poll(M);
    const ev3 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev3).toMatchObject({ kind: 'leverage', leverage: 20 });
    x = await execs(ev3.id);
    expect(x[F1].status).toBe('ok');
    expect(x[F1].detail).toContain('5→10배');
    expect((await paper().state(F1)).positions[0].leverage).toBe(10);
    expect((await listCopyPositions(env.DB, F1))[0].leverage).toBe(10);

    // 고수가 절반 정리 → reduce → F1 장부 절반
    await paper().reduce(M, 'ETHUSDT', 100);
    r = await poll(M);
    const ev4 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev4).toMatchObject({ kind: 'reduce', beforeContracts: 200, afterContracts: 100 });
    x = await execs(ev4.id);
    expect(x[F1]).toMatchObject({ status: 'ok', contracts: 50 });
    expect((await listCopyPositions(env.DB, F1))[0].contracts).toBe(50);
    expect((await paper().state(F1)).positions[0].contracts).toBe(50);

    // 가격 2600 에서 고수 전량 정리 → close → 장부 삭제 + 실현손익 ≈ (2600−2500)×50×0.001 = 5
    await setPrices({ ETHUSDT: 2_600 });
    await paper().close(M, 'ETHUSDT');
    r = await poll(M);
    const ev5 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev5).toMatchObject({ kind: 'close', beforeContracts: 100, afterContracts: 0, closeReason: 'normal' });   // 연습 고수는 거래소가 없으니 바로 normal
    x = await execs(ev5.id);
    expect(x[F1]).toMatchObject({ status: 'ok', contracts: 50 });
    expect(await listCopyPositions(env.DB, F1)).toEqual([]);
    expect((await paper().state(F1)).positions).toEqual([]);
    let fr = (await getFollow(env.DB, f1))!;
    const closes = (await paper().state(F1)).history.filter((h) => h.type === 'close' && h.symbol === 'ETHUSDT');   // reduce(손익 0, 수수료만) + close(+5)
    expect(closes.reduce((a, h) => a + (h.pnl ?? 0), 0)).toBeCloseTo(5, 6);
    expect(fr.realizedPnl).toBeCloseTo(closes.reduce((a, h) => a + (h.pnl ?? 0) - (h.fee ?? 0), 0), 1);   // 수수료 차감 (연습 엔진이 알려준 값, 단계별 소수 2자리)
    expect(fr.copyAmountNow).toBeCloseTo(500 + fr.realizedPnl, 6);

    // 손실 한도: F1 실현손익을 −295 로 (한도 250) → 다음 이벤트에서 멈추고 건너뜀. F2 는 이제 정상 진입
    await addRealizedPnl(env.DB, f1, -300);
    await openMaster(M, { stopLossPrice: 2_400, takeProfitPrice: null });
    r = await poll(M);
    const ev6 = (await getEvent(env.DB, r.events[0]))!;
    expect(ev6.kind).toBe('open');
    x = await execs(ev6.id);
    expect(x[F1]).toMatchObject({ status: 'skipped', detail: '손실 한도 도달 — 멈추고 정리했어요' });
    fr = (await getFollow(env.DB, f1))!;
    expect(fr).toMatchObject({ status: 'stopped', stopReason: 'loss_limit' });
    expect(x[F2].status).toBe('ok');
    expect((await listCopyPositions(env.DB, F2))[0]).toMatchObject({ symbol: 'ETHUSDT', slPrice: 2_400, tpPrice: null });
    // 고수가 손절을 지우면 팔로워 손절도 해제 (고수와 완전히 동일, 2026-09-18)
    await paper().tpsl(M, { symbol: 'ETHUSDT', stopLossPrice: null });
    r = await poll(M);
    x = await execs(r.events[0]);
    expect(x[F2]).toMatchObject({ status: 'ok' });
    expect(x[F2].detail).toContain('손절 해제');
    expect((await listCopyPositions(env.DB, F2))[0]).toMatchObject({ symbol: 'ETHUSDT', slPrice: null });

    // 해지·관리자용: 팔로워 장부 전량 정리
    let c = (await (await copyStub(env).fetch('https://copy/follower/close', { method: 'POST', body: JSON.stringify({ followerId: F2 }), headers: J })).json()) as { ok: boolean; results: { status: string }[] };
    expect(c.ok).toBe(true);
    expect(c.results).toHaveLength(1);
    expect(c.results[0].status).toBe('ok');
    expect(await listCopyPositions(env.DB, F2)).toEqual([]);
    expect((await paper().state(F2)).positions).toEqual([]);
    c = (await (await copyStub(env).fetch('https://copy/follower/close', { method: 'POST', body: JSON.stringify({ followerId: F2 }), headers: J })).json()) as typeof c;
    expect(c).toMatchObject({ ok: true, results: [] });

    // 60초 점검 경로: 한도 넘김 → stopped(loss_limit) (시세는 30초 안에 갱신된 것이어야 한다)
    await addRealizedPnl(env.DB, f2, -300);
    await setPrices({ ETHUSDT: 2_600 });
    const k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F2 }), headers: J })).json()) as { ok: boolean; stopped: boolean; used: number };
    expect(k.stopped).toBe(true);
    expect(k.used).toBeGreaterThan(1);
    expect((await getFollow(env.DB, f2))!).toMatchObject({ status: 'stopped', stopReason: 'loss_limit' });
    const k2 = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F2 }), headers: J })).json()) as { ok: boolean };
    expect(k2.ok).toBe(false);
  }, 60_000);

  it('same event id never runs twice; direction flip = close then open', async () => {
    await setPrices({});
    const M = await mkMaster('cmaster2', '92000011');
    const F1 = await mkUser('cfol3', '92000012');
    await follow(F1, M);
    await poll(M);
    await openMaster(M);
    const r = await poll(M);
    expect(r.events).toHaveLength(1);
    // 같은 이벤트를 다시 던져도 실행 기록은 하나
    const again = (await (await copyStub(env).fetch('https://copy/run', { method: 'POST', body: JSON.stringify({ eventId: r.events[0] }), headers: J })).json()) as { ok: number; followers: number };
    expect(again.followers).toBe(1); // 이미 processed → 저장된 집계 반환
    expect((await listEventExecutions(env.DB, r.events[0])).length).toBe(1);
    expect((await listCopyPositions(env.DB, F1))[0].contracts).toBe(100);
    // 방향 전환: 고수가 롱을 닫고 숏으로 → close, open 두 이벤트 (seq 2, 3)
    await paper().close(M, 'ETHUSDT');
    await paper().open(M, { symbol: 'ETHUSDT', direction: 'short', amountUsdt: 100, leverage: 5, stopLossPrice: 2_700 }, 200, ETH);
    const r2 = await poll(M);
    expect(r2.events).toEqual([`copy-${M}-ETHUSDT-2`, `copy-${M}-ETHUSDT-3`]);
    expect((await getEvent(env.DB, r2.events[0]))!.kind).toBe('close');
    expect((await getEvent(env.DB, r2.events[1]))!).toMatchObject({ kind: 'open', direction: 'short', slPrice: 2_700 });
    const book = (await listCopyPositions(env.DB, F1))[0];
    expect(book).toMatchObject({ direction: 'short', contracts: 100, slPrice: 2_700 });
    expect((await paper().state(F1)).positions[0]).toMatchObject({ direction: 'short', contracts: 100, stopLossPrice: 2_700 });
  }, 60_000);

  it('live follower without an API key is skipped and the follow stops (no_api_key)', async () => {
    await setPrices({});
    const M = await mkMaster('cmaster3', '92000021');
    const F1 = await mkUser('cfol4', '92000022');
    await saveSettings(env, F1, { mode: 'live', maxLeverage: 100, maxAmountUsdt: 100000, usdtKrw: 1380 });
    const fid = await createFollow(env.DB, F1, M, 'live', FOLLOW, COPY_TERMS_VERSION);
    // F2: 연습으로 시작한 팔로우인데 지금은 실거래 모드 → 모드가 달라 실행하지 않는다
    const F2 = await mkUser('cfol6', '92000023');
    await saveSettings(env, F2, { mode: 'live', maxLeverage: 100, maxAmountUsdt: 100000, usdtKrw: 1380 });
    await follow(F2, M);
    await poll(M);
    await openMaster(M);
    const r = await poll(M);
    const x = await execs(r.events[0]);
    expect(x[F1]).toMatchObject({ status: 'skipped', detail: 'API 키 없음', mode: 'live' });
    expect((await getFollow(env.DB, fid))!).toMatchObject({ status: 'stopped', stopReason: 'no_api_key' });
    expect(x[F2]).toMatchObject({ status: 'skipped', detail: '모드가 바뀌어 실행하지 않았어요' });
  }, 30_000);

  it('kick: unapproved master gets no alarm; kickMasters arms approved masters and the alarm polls', async () => {
    await setPrices({});
    const P = await mkMaster('cmaster4', '92000031', false);
    let k = (await (await masterStub(env, P).fetch('https://master/kick', { method: 'POST' })).json()) as { ok: boolean; alarm: number | null };
    expect(k).toMatchObject({ ok: false, alarm: null });
    expect((await status(P)).alarm).toBeNull();

    const M = await mkMaster('cmaster5', '92000032');
    expect((await status(M)).alarm).toBeNull();
    await kickMasters(env);
    let s = await status(M);
    expect(s.alarm).not.toBeNull();
    expect(s.lastPollAt).toBeNull();
    expect((await status(P)).alarm).toBeNull();   // 미승인은 여전히 없음
    // 알람 실행 → 기준선 폴링
    expect(await runDurableObjectAlarm(masterStub(env, M))).toBe(true);
    s = await status(M);
    expect(s.lastPollAt).not.toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.wsOk).toBe(false);   // 연습 마스터는 WS 없음
    expect((await getMasterState(env.DB, M)).size).toBe(3);
    // 승인 취소 → kick 이 알람을 지운다
    await setMasterStatus(env.DB, M, 'suspended', 'admin', '테스트');
    k = (await (await masterStub(env, M).fetch('https://master/kick', { method: 'POST' })).json()) as typeof k;
    expect(k.ok).toBe(false);
    expect((await status(M)).alarm).toBeNull();
    await masterStub(env, M).fetch('https://master/stop', { method: 'POST' });
  }, 30_000);
});

describe('copy trading: exchange-side stop loss settles the book; watcher refuses a following master', () => {
  it('SL hit → realized pnl from history (check-loss path and close-event path); master following someone is not watched', async () => {
    await setPrices({});
    const M = await mkMaster('cmaster6', '92000041');
    const F5 = await mkUser('cfol7', '92000042');
    const F6 = await mkUser('cfol8', '92000043');
    const f5 = await follow(F5, M);
    const f6 = await follow(F6, M);
    await poll(M);
    await openMaster(M, { stopLossPrice: 2_300, takeProfitPrice: null });
    let r = await poll(M);
    let x = await execs(r.events[0]);
    expect(x[F5].status).toBe('ok'); expect(x[F6].status).toBe('ok');
    expect((await listCopyPositions(env.DB, F5))[0]).toMatchObject({ contracts: 100, slPrice: 2_300 });
    // 가격이 손절 아래로 → 연습 엔진이 고수·팔로워 모두 손절 체결
    await setPrices({ ETHUSDT: 2_290 });
    expect((await paper().state(F5)).positions).toEqual([]);
    const slEv = (await paper().state(F5)).history.find((h) => h.type === 'sl')!;
    expect(slEv).toBeDefined();
    const expected = (slEv.pnl ?? 0) - (slEv.fee ?? 0);
    // (1) 60초 점검 경로: 장부를 실제 계좌와 맞추며 손절 손익을 실현손익에 반영, 한도(250) 안이라 계속
    const k = (await (await copyStub(env).fetch('https://copy/check-loss', { method: 'POST', body: JSON.stringify({ followerId: F5 }), headers: J })).json()) as { ok: boolean; stopped: boolean; used: number };
    expect(k).toMatchObject({ ok: true, stopped: false });
    expect(await listCopyPositions(env.DB, F5)).toEqual([]);
    expect((await getFollow(env.DB, f5))!.realizedPnl).toBeCloseTo(expected, 1);
    expect(expected).toBeLessThan(-19);
    // (2) 고수 close 이벤트 경로: F6 은 실제 포지션이 이미 없어 장부만 정산
    r = await poll(M);
    const ev = (await getEvent(env.DB, r.events[0]))!;
    expect(ev.kind).toBe('close');
    x = await execs(ev.id);
    expect(x[F5]).toMatchObject({ status: 'skipped', detail: '따라 들어간 포지션 없음' });
    expect(x[F6].status).toBe('skipped'); expect(x[F6].detail).toBe('따라 들어간 포지션 없음');   // 실행 전 장부 대조에서 이미 정산·삭제
    expect((await getFollow(env.DB, f6))!.realizedPnl).toBeCloseTo(expected, 1);
    expect(await listCopyPositions(env.DB, F6)).toEqual([]);
    // 실행 선점: 같은 이벤트·팔로워는 한 번만
    await insertEvent(env.DB, { id: `copy-${M}-ETHUSDT-999`, masterId: M, seq: 999, symbol: 'ETHUSDT', kind: 'open', direction: 'long', beforeContracts: 0, afterContracts: 1, price: 2_500, leverage: 5, masterEquity: 1000, createdAt: Date.now() });
    expect(await claimCopyExecution(env.DB, `copy-${M}-ETHUSDT-999`, F5, 'paper')).toBe(true);
    expect(await claimCopyExecution(env.DB, `copy-${M}-ETHUSDT-999`, F5, 'paper')).toBe(false);
    // 고수가 다른 고수를 따라가는 중이면 감시 정지 (순환 증폭 방지)
    await createFollow(env.DB, M, F5, 'paper', FOLLOW, COPY_TERMS_VERSION);
    await openMaster(M, { stopLossPrice: 2_200, takeProfitPrice: null });
    r = await poll(M);
    expect(r.events).toEqual([]);
    expect((await status(M)).lastError).toContain('감시 정지');
  }, 60_000);
});

describe('gateShrink (live master shrink needs two consecutive polls)', () => {
  const close = [{ kind: 'close' as const, direction: 'long' as const, before: 5, after: 0 }];
  const add = [{ kind: 'add' as const, direction: 'long' as const, before: 5, after: 8 }];
  it('holds the first shrink, emits on confirmation, never holds growth or paper masters', () => {
    const pending = new Map<Symbol, number>();
    expect(gateShrink(pending, 'ETHUSDT', close, 0, true)).toEqual({ emit: [], held: true });
    expect(pending.get('ETHUSDT')).toBe(0);
    expect(gateShrink(pending, 'ETHUSDT', close, 0, true)).toEqual({ emit: close, held: false });
    expect(pending.has('ETHUSDT')).toBe(false);
    // 한 번 비었다가 다음 폴링에 다시 커지면(순간 오류) 보류를 풀고 보통 디프로
    expect(gateShrink(pending, 'ETHUSDT', close, 0, true).held).toBe(true);
    expect(gateShrink(pending, 'ETHUSDT', add, 8, true)).toEqual({ emit: add, held: false });
    expect(gateShrink(pending, 'ETHUSDT', close, 0, false)).toEqual({ emit: close, held: false });
  });
});

describe('diffSymbol', () => {
  const S = (o: Partial<Parameters<typeof diffSymbol>[0]> = {}) => ({ direction: null, contracts: 0, entryPrice: null, leverage: null, slPrice: null, tpPrice: null, ...o });
  it('size changes', () => {
    expect(diffSymbol(S(), S())).toEqual([]);
    expect(diffSymbol(S(), S({ direction: 'long', contracts: 3, leverage: 5, slPrice: 1 }))).toEqual([{ kind: 'open', direction: 'long', before: 0, after: 3 }]);
    expect(diffSymbol(S({ direction: 'long', contracts: 3 }), S({ direction: 'long', contracts: 5 }))).toEqual([{ kind: 'add', direction: 'long', before: 3, after: 5 }]);
    expect(diffSymbol(S({ direction: 'long', contracts: 5 }), S({ direction: 'long', contracts: 2 }))).toEqual([{ kind: 'reduce', direction: 'long', before: 5, after: 2 }]);
    expect(diffSymbol(S({ direction: 'long', contracts: 5 }), S())).toEqual([{ kind: 'close', direction: 'long', before: 5, after: 0 }]);
    expect(diffSymbol(S({ direction: 'long', contracts: 5 }), S({ direction: 'short', contracts: 4 }))).toEqual([{ kind: 'close', direction: 'long', before: 5, after: 0 }, { kind: 'open', direction: 'short', before: 0, after: 4 }]);
  });
  it('tpsl / leverage only when size unchanged (open/add already carry them), tolerance = price precision', () => {
    const base = S({ direction: 'long', contracts: 5, leverage: 5, slPrice: 100, tpPrice: null });
    expect(diffSymbol(base, { ...base })).toEqual([]);
    expect(diffSymbol(base, { ...base, slPrice: 100.04 }, 0.1)).toEqual([]);
    expect(diffSymbol(base, { ...base, slPrice: 101 }, 0.1)).toEqual([{ kind: 'tpsl', direction: 'long', before: 5, after: 5 }]);
    expect(diffSymbol(base, { ...base, tpPrice: 120 })).toEqual([{ kind: 'tpsl', direction: 'long', before: 5, after: 5 }]);
    expect(diffSymbol(base, { ...base, slPrice: null })).toEqual([{ kind: 'tpsl', direction: 'long', before: 5, after: 5 }]);
    expect(diffSymbol(base, { ...base, leverage: 10 })).toEqual([{ kind: 'leverage', direction: 'long', before: 5, after: 5 }]);
    expect(diffSymbol(base, { ...base, slPrice: 90, leverage: 10 })).toEqual([{ kind: 'tpsl', direction: 'long', before: 5, after: 5 }, { kind: 'leverage', direction: 'long', before: 5, after: 5 }]);
    // reduce + 손절 변경 → reduce 먼저, tpsl 다음. add 는 손절을 싣고 가므로 tpsl 없음
    expect(diffSymbol(base, { ...base, contracts: 2, slPrice: 90 }).map((e) => e.kind)).toEqual(['reduce', 'tpsl']);
    expect(diffSymbol(base, { ...base, contracts: 8, slPrice: 90, leverage: 10 }).map((e) => e.kind)).toEqual(['add']);
    expect(diffSymbol(base, { ...base, contracts: 0, slPrice: 90 }).map((e) => e.kind)).toEqual(['close']);
  });
});
