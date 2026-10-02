// DO 생존성 보강 (감사 2026-09-18 A 절): VANISHED 판정(A2)·고아 pending 복구(A5)·폴링 백오프(A6)·unrealizedOf 종목 누락(A19)
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION, type CopyFollowSettings, type Symbol } from '@easy-futures/shared';
import { createUser, saveSettings } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { FALLBACK_CONTRACTS } from '../market.js';
import { applyMaster, claimCopyExecution, copyClientOrderId, createFollow, finishEvent, insertEvent, listAllExpiredPendingExecutions, listEventExecutions, PENDING_UNKNOWN_DETAIL, setMasterStatus } from './db.js';
import { copyStub, unrealizedOf } from './CopyTrader.js';
import { kickMasters, masterStub, vanishedSuspect } from './MasterWatcher.js';

const J = { 'content-type': 'application/json' };
const FOLLOW: CopyFollowSettings = { copyAmount: 500, lossLimitPct: 50, maxLeverage: 10, slRoi: 50 };

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
async function setPrices(p: Partial<Record<Symbol, number>>) {
  await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) });
  await new Promise((r) => setTimeout(r, 1100));
}
const status = async (masterId: number) => (await (await masterStub(env, masterId).fetch('https://master/status')).json()) as { alarm: number | null; lastError: string | null; pollFailures: number; authFailures: number };
const execsOf = async (eventId: string) => Object.fromEntries((await listEventExecutions(env.DB, eventId)).map((x) => [x.followerId, x]));
async function mkEvent(masterId: number, seq: number, kind: 'open' | 'close' = 'open') {
  const id = `copy-${masterId}-ETHUSDT-${seq}`;
  expect(await insertEvent(env.DB, { id, masterId, seq, symbol: 'ETHUSDT', kind, direction: 'long', beforeContracts: 0, afterContracts: 200, price: 2_500, leverage: 5, masterEquity: 1_000, createdAt: Date.now(), slPrice: 2_300, tpPrice: null })).toBe(true);
  return id;
}

describe('pure helpers (A2, A19)', () => {
  it('vanishedSuspect: only when the raw (unfiltered) position list is empty too — an unsupported symbol keeps margin > 0 legitimately', () => {
    expect(vanishedSuspect(false, 2, 0, 0, 12.5)).toBe(true);          // 전부 사라짐 + 원본도 0 + 증거금 남음 → 의심
    expect(vanishedSuspect(false, 2, 0, 1, 12.5)).toBe(false);         // XRP 등 미지원 종목이 남아 있음 → 정상 (close 이벤트가 나가야 한다)
    expect(vanishedSuspect(false, 2, 0, undefined, 12.5)).toBe(true);  // 연습 어댑터(필드 없음) 는 종전과 같은 규칙
    expect(vanishedSuspect(false, 2, 0, 0, 0)).toBe(false);            // 증거금 0 → 진짜 정리
    expect(vanishedSuspect(true, 0, 0, 0, 12.5)).toBe(false);          // 첫 폴링은 판정 안 함
    expect(vanishedSuspect(false, 2, 1, 0, 12.5)).toBe(false);         // 하나라도 남아 있으면 정상
    expect(vanishedSuspect(false, 0, 0, 0, 12.5)).toBe(false);         // 직전에도 없었으면 정상
  });
  it('unrealizedOf skips a book whose symbol is no longer in the contract list instead of throwing', () => {
    const now = Date.now();
    const prices = { ETHUSDT: { last: 2_500, mark: 2_500, updatedAt: now } };
    const eth = { followerId: 1, masterId: 2, symbol: 'ETHUSDT' as const, direction: 'long' as const, contracts: 100, entryPrice: 2_400, leverage: 5, openedAt: now, updatedAt: now };
    const gone = { ...eth, symbol: 'XRPUSDT' as Symbol };
    const onlyEth = unrealizedOf([eth], prices, FALLBACK_CONTRACTS);
    expect(onlyEth).toBeGreaterThan(0);
    expect(unrealizedOf([eth, gone], prices, FALLBACK_CONTRACTS)).toBe(onlyEth);
  });
});

describe('orphaned pending executions are recovered globally (A5)', () => {
  it('/recover-pending closes a >2min pending row even though its event is already processed; fresh pending rows stay', async () => {
    await setPrices({ ETHUSDT: 2_500, BTCUSDT: 80_000, SOLUSDT: 100 });
    const M = await mkMaster('rlmaster1', '94000001');
    const F1 = await mkUser('rlfol1', '94000002');
    const F2 = await mkUser('rlfol2', '94000003');
    await createFollow(env.DB, F1, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    await createFollow(env.DB, F2, M, 'paper', FOLLOW, COPY_TERMS_VERSION);
    // 이벤트 1: 정상 처리 → processed
    const e1 = await mkEvent(M, 1);
    let r = await copyStub(env).fetch('https://copy/run', { method: 'POST', body: JSON.stringify({ eventId: e1 }), headers: J });
    expect(r.status).toBe(200);
    expect((await execsOf(e1))[F1].status).toBe('ok');
    // 이벤트 2: 코디네이터가 닫았는데(processed) F2 의 선점 행이 pending 으로 3분째 남은 상황(샤드가 주문 뒤·기록 전에 죽음) + F1 은 방금 선점(신선)
    const e2 = await mkEvent(M, 2);
    expect(await claimCopyExecution(env.DB, e2, F2, 'paper', copyClientOrderId(M, 2, F2))).toBe(true);
    await env.DB.prepare('UPDATE copy_executions SET created_at = ? WHERE event_id = ? AND follower_id = ?').bind(Date.now() - 3 * 60_000, e2, F2).run();
    expect(await claimCopyExecution(env.DB, e2, F1, 'paper', copyClientOrderId(M, 2, F1))).toBe(true);
    await finishEvent(env.DB, e2, 2, 0, 0, 0);
    // 이벤트 단위 실행은 processed 라 즉시 반환 → 고아 행은 그대로 (이게 감사 A5 의 구멍)
    r = await copyStub(env).fetch('https://copy/run', { method: 'POST', body: JSON.stringify({ eventId: e2, recovery: true }), headers: J });
    expect(r.status).toBe(200);
    let x = await execsOf(e2);
    expect(x[F2].status).toBe('pending');
    expect((await listAllExpiredPendingExecutions(env.DB, 2 * 60_000)).map((p) => [p.eventId, p.followerId])).toEqual([[e2, F2]]);
    // 전역 복구 → 오래된 pending 만 결과 불명 실패로 닫힌다
    const rec = (await (await copyStub(env).fetch('https://copy/recover-pending', { method: 'POST' })).json()) as { ok: boolean; events: number; expired: number };
    expect(rec).toEqual({ ok: true, events: 1, expired: 1 });
    x = await execsOf(e2);
    expect(x[F2]).toMatchObject({ status: 'failed', detail: PENDING_UNKNOWN_DETAIL });
    expect(x[F1].status).toBe('pending');   // 신선한 선점 행은 건드리지 않는다
    expect(await listAllExpiredPendingExecutions(env.DB, 2 * 60_000)).toEqual([]);
    // 다시 불러도 할 일 없음
    expect(await (await copyStub(env).fetch('https://copy/recover-pending', { method: 'POST' })).json()).toEqual({ ok: true, events: 0, expired: 0 });
  }, 30_000);
});

describe('master polling backs off on consecutive failures (A6)', () => {
  it('live master without an API key: alarm interval doubles per failed poll (2s → 4s → 8s → 16s), capped at 60s, and the alarm always re-arms', async () => {
    const M = await mkMaster('rlmaster2', '94000011');
    await saveSettings(env, M, { mode: 'live', maxLeverage: 100, maxAmountUsdt: 100000, usdtKrw: 1380 });   // 실거래 모드 + 키 없음 → 폴링마다 'API 키 없음'
    await kickMasters(env);
    expect((await status(M)).alarm).not.toBeNull();
    const expectDelay = async (failures: number, minMs: number, maxMs: number) => {
      const before = Date.now();
      expect(await runDurableObjectAlarm(masterStub(env, M))).toBe(true);
      const s = await status(M);
      expect(s.pollFailures).toBe(failures);
      expect(s.authFailures).toBe(0);   // 키 없음은 키 거절(401)이 아니다
      expect(s.lastError).toContain('API 키 없음');
      expect(s.alarm).not.toBeNull();
      const delay = s.alarm! - before;
      expect(delay).toBeGreaterThanOrEqual(minMs);
      expect(delay).toBeLessThanOrEqual(maxMs);
    };
    await expectDelay(1, 4_000, 6_000);     // 2s × 2^1
    await expectDelay(2, 8_000, 10_000);    // 2s × 2^2
    await expectDelay(3, 16_000, 18_000);   // 2s × 2^3
    await expectDelay(4, 32_000, 34_000);   // 2s × 2^4
    await expectDelay(5, 60_000, 62_000);   // 2s × 2^5 = 64s → 상한 60s
    await expectDelay(6, 60_000, 62_000);   // 그 이상은 60s 고정
    await masterStub(env, M).fetch('https://master/stop', { method: 'POST' });
    expect((await status(M)).alarm).toBeNull();
  }, 30_000);
});
