// 카피 부분 정리 이월 (2026-09-22): 장부 1~2계약 팔로워가 고수의 작은 축소에 전량 정리되지 않게 — 1계약 미만은 다음 축소에 합산, 전량 정리·추가 진입은 이월 0
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { calcContracts, COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION, type CopyFollowSettings, type Symbol } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { FALLBACK_CONTRACTS } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { applyMaster, createFollow, getEvent, listCopyPositions, listEventExecutions, setMasterStatus } from './db.js';
import { REDUCE_CARRY_DETAIL, reduceContracts } from './sizing.js';
import { masterStub } from './MasterWatcher.js';

const ETH = FALLBACK_CONTRACTS.ETHUSDT;
const paper = () => new PaperClient(env);

describe('reduceContracts 이월 (순수 함수)', () => {
  it('장부 1계약, 고수가 40% 씩 세 번 줄이면 세 번째에 1계약 정리 (0.4 → 0.8 → 1.2)', () => {
    let carry = 0;
    const a = reduceContracts(100, 60, 1, carry);
    expect(a).toEqual({ contracts: 0, carry: 0.4 });
    carry = a.carry;
    const b = reduceContracts(60, 36, 1, carry);
    expect(b.contracts).toBe(0); expect(b.carry).toBeCloseTo(0.8, 6);
    carry = b.carry;
    const c = reduceContracts(36, 21.6, 1, carry);   // 1.2 → 1계약, 0.2 이월 (장부가 비면 행이 지워져 이월은 의미 없음)
    expect(c.contracts).toBe(1); expect(c.carry).toBeCloseTo(0.2, 6);
    expect(REDUCE_CARRY_DETAIL(0.4)).toBe('고수가 줄인 비율이 1계약 미만 — 다음 축소에 합산 (이월 0.4계약)');
  });
  it('고수가 0 이 되면 이월과 무관하게 전량', () => {
    expect(reduceContracts(100, 0, 1, 0.4)).toEqual({ contracts: 1, carry: 0 });
    expect(reduceContracts(100, 0, 3, 0.9)).toEqual({ contracts: 3, carry: 0 });
  });
});

async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
async function mkMaster(loginId: string, uid: string) {
  const id = await mkUser(loginId, uid);
  await applyMaster(env.DB, id, loginId, '테스트 고수', MASTER_TERMS_VERSION);
  expect(await setMasterStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
  return id;
}
/** 따라갈 돈 6: 고수(연습 자산 1,000) 100 USDT 5배 = 자산의 10% → 팔로워 0.6 USDT 5배 = 명목 3 → 1계약 (0.001 ETH @2500 = 2.5) */
const FOLLOW: CopyFollowSettings = { copyAmount: 6, lossLimitPct: 50, maxLeverage: 10, slRoi: 50 };
async function setPrices(p: Partial<Record<Symbol, number>>) {
  await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100, ...p }) });
  await new Promise((r) => setTimeout(r, 1100));
}
async function poll(masterId: number) {
  const r = await masterStub(env, masterId).fetch('https://master/poll', { method: 'POST' });
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: boolean; events: string[] };
}
const execOf = async (eventId: string, followerId: number) => (await listEventExecutions(env.DB, eventId)).find((e) => e.followerId === followerId)!;
const carryOf = async (followerId: number) => Number((await env.DB.prepare("SELECT reduce_carry AS c FROM copy_positions WHERE follower_id = ? AND symbol = 'ETHUSDT'").bind(followerId).first<{ c: number }>())?.c ?? NaN);
const openMaster = (masterId: number) => paper().open(masterId, { symbol: 'ETHUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 2_300, takeProfitPrice: 2_800 }, calcContracts(100, 5, 2_500, ETH), ETH);

describe('reduce carry end to end (paper master + 1-contract paper follower)', () => {
  it('40% 축소는 이월(skipped), 추가 진입은 이월 0, 누적 1계약 넘으면 1계약 정리, 고수 전량 정리는 전량', async () => {
    await setPrices({});
    const M = await mkMaster('cmaster1', '93000001');   // 연습 고수 감시는 관리자 계정만 (vitest.config ADMIN_LOGIN_IDS) — 파일마다 저장소가 격리돼 다른 테스트와 겹치지 않는다
    const F = await mkUser('rcfol', '93000002');
    await createFollow(env.DB, F, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    expect((await poll(M)).events).toEqual([]);   // 기준선

    // 고수 200계약 진입 → 팔로워 1계약
    await openMaster(M);
    let r = await poll(M);
    expect((await getEvent(env.DB, r.events[0]))!.kind).toBe('open');
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'ok', contracts: 1 });
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(1);
    expect(await carryOf(F)).toBe(0);

    // 고수 200 → 120 (40% 축소) → 0.4계약: 정리하지 않고 이월
    await paper().reduce(M, 'ETHUSDT', 80);
    r = await poll(M);
    expect((await getEvent(env.DB, r.events[0]))!).toMatchObject({ kind: 'reduce', beforeContracts: 200, afterContracts: 120 });
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'skipped', detail: REDUCE_CARRY_DETAIL(0.4), contracts: 0 });
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(1);
    expect(await carryOf(F)).toBeCloseTo(0.4, 6);
    expect((await paper().state(F)).positions[0].contracts).toBe(1);

    // 고수 추가 진입 120 → 320 → 팔로워 +1 = 2계약, 이월 0 으로
    await openMaster(M);
    r = await poll(M);
    expect((await getEvent(env.DB, r.events[0]))!).toMatchObject({ kind: 'add', beforeContracts: 120, afterContracts: 320 });
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'ok', contracts: 1 });
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(2);
    expect(await carryOf(F)).toBe(0);

    // 320 → 192 (40%) → 0.8 이월
    await paper().reduce(M, 'ETHUSDT', 128);
    r = await poll(M);
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'skipped', detail: REDUCE_CARRY_DETAIL(0.8) });
    expect(await carryOf(F)).toBeCloseTo(0.8, 6);
    // 192 → 115 (40.1%) → 0.8 + 0.802 = 1.602 → 1계약 정리, 0.602 이월
    await paper().reduce(M, 'ETHUSDT', 77);
    r = await poll(M);
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'ok', contracts: 1 });
    expect((await listCopyPositions(env.DB, F))[0].contracts).toBe(1);
    expect(await carryOf(F)).toBeCloseTo(0.8 + 2 * (77 / 192) - 1, 4);   // ≈ 0.602
    expect((await paper().state(F)).positions[0].contracts).toBe(1);

    // 고수 전량 정리 → 팔로워 전량 (행 삭제)
    await paper().close(M, 'ETHUSDT');
    r = await poll(M);
    expect((await getEvent(env.DB, r.events[0]))!.kind).toBe('close');
    expect(await execOf(r.events[0], F)).toMatchObject({ status: 'ok', contracts: 1 });
    expect(await listCopyPositions(env.DB, F)).toEqual([]);
    expect((await paper().state(F)).positions).toEqual([]);
  }, 60_000);
});
