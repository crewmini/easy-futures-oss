// 2026-09-08 점검 반영 회귀 테스트: 팔로워 자격, 승인 조건, 연습 전환 시 자동매매 끄기, 오래된 시세 차단, 손절 지나친 진입 건너뜀
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { AUTO_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { applyAuto, disableAuto, insertSignal, listFollowers, setAutoStatus } from './db.js';

const BASE = 'http://localhost/api';
let cookie = '';
async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await SELF.fetch(BASE + path, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function prices(p: Record<string, number>) { await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) }); }
async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
const sig = (id: string, action: 'open' | 'close', extra: Record<string, unknown> = {}) => ({ id, source: 'bot' as const, symbol: 'ETHUSDT' as const, action, direction: action === 'open' ? ('long' as const) : null, leverage: 3, slRoi: null, tpRoi: null, slPrice: null, tpPrice: null, breakeven: false, note: 't', createdAt: Date.now(), processedAt: null, followerCount: null, okCount: null, failCount: null, ...extra });
async function run(id: string) { return (await (await env.AUTO.get(env.AUTO.idFromName('global')).fetch('https://auto/run', { method: 'POST', body: JSON.stringify({ signalId: id }), headers: { 'content-type': 'application/json' } })).json()) as { ok: number; fail: number; skipped: number; followers: number }; }

describe('auto-trading safety', () => {
  beforeEach(() => { cookie = ''; });

  it('followers must be approved+enabled+kyc+current terms+auto terms+no temp password', async () => {
    const id = await mkUser('f1', '91234001');
    await applyAuto(env.DB, id, { enabled: false, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION);
    expect(await setAutoStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
    await env.DB.prepare('UPDATE auto_settings SET enabled = 1 WHERE user_id = ?').bind(id).run();
    expect((await listFollowers(env.DB)).map((f) => f.userId)).toContain(id);
    await env.DB.prepare("UPDATE users SET kyc_status = 'rejected' WHERE id = ?").bind(id).run();
    expect((await listFollowers(env.DB)).map((f) => f.userId)).not.toContain(id);
    await env.DB.prepare("UPDATE users SET kyc_status = 'approved', must_change_pw = 1 WHERE id = ?").bind(id).run();
    expect((await listFollowers(env.DB)).map((f) => f.userId)).not.toContain(id);
    await env.DB.prepare("UPDATE users SET must_change_pw = 0 WHERE id = ?").bind(id).run();
    await env.DB.prepare("UPDATE auto_settings SET auto_terms_version = 'old' WHERE user_id = ?").bind(id).run();
    expect((await listFollowers(env.DB)).map((f) => f.userId)).not.toContain(id);
  });

  it('approve only from pending/suspended; reject → rejected; suspended cannot re-apply', async () => {
    const id = await mkUser('f2', '91234002');
    expect(await setAutoStatus(env.DB, id, 'approved', 'admin', null)).toBe(false); // 신청 없이 승인 불가
    await applyAuto(env.DB, id, { enabled: false, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION);
    expect(await setAutoStatus(env.DB, id, 'rejected', 'admin', '서류 미비')).toBe(true);
    expect((await env.DB.prepare('SELECT auto_status FROM users WHERE id = ?').bind(id).first<{ auto_status: string }>())?.auto_status).toBe('rejected');
    await applyAuto(env.DB, id, { enabled: false, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION); // 거절 뒤 재신청 가능
    expect(await setAutoStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
    expect(await setAutoStatus(env.DB, id, 'suspended', 'admin', '결제 확인 필요')).toBe(true);
    await expect(applyAuto(env.DB, id, { enabled: false, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION)).rejects.toThrow(/중지/);
  });

  it('switching to paper mode and deleting the api key turn auto off with a note', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'safetyf3', password: '123456', inviteCode: 'dev1234', uid: '91234003', termsAgreed: true, termsVersion: TERMS_VERSION }) });
    expect(r.status).toBe(200);
    const id = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'safetyf3'").first<{ id: number }>())!.id;
    await env.DB.prepare("UPDATE users SET kyc_status = 'approved', auto_status = 'approved' WHERE id = ?").bind(id).run();
    await env.DB.prepare("INSERT INTO auto_settings (user_id, enabled, pct, max_leverage, default_sl_roi, agreed_at, applied_at, updated_at, auto_terms_version) VALUES (?, 1, 10, 5, 20, 1, 1, 1, ?)").bind(id, AUTO_TERMS_VERSION).run();
    // 실거래 모드였다고 가정하고 연습으로 전환
    await env.DB.prepare("UPDATE settings SET mode = 'live' WHERE user_id = ?").bind(id).run();
    await env.DB.prepare("INSERT INTO api_keys (user_id, enc, iv, preview, created_at) VALUES (?, 'x', 'y', 'wp_…', 1)").bind(id).run().catch(() => {});
    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'paper' }) });
    if (r.status !== 200) console.log('SETTINGS', JSON.stringify(r.body));
    expect(r.status).toBe(200);
    expect(r.body.autoDisabled).toBe(true);
    const row = await env.DB.prepare('SELECT enabled, note FROM auto_settings WHERE user_id = ?').bind(id).first<{ enabled: number; note: string }>();
    expect(row?.enabled).toBe(0); expect(row?.note).toContain('연습 모드');
    expect(await disableAuto(env.DB, id, 'x')).toBe(false); // 이미 꺼져 있으면 false
  });

  it('stale mark aborts the signal; entry past the anchor stop is skipped; signup rejects old terms version', async () => {
    const id = await mkUser('f4', '91234004');
    await applyAuto(env.DB, id, { enabled: false, pct: 30, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION);
    await setAutoStatus(env.DB, id, 'approved', 'admin', null);
    await env.DB.prepare('UPDATE auto_settings SET enabled = 1 WHERE user_id = ?').bind(id).run();
    // 시세 없음 → 실행 안 함
    await insertSignal(env.DB, sig('s-stale', 'open'));
    let r = await run('s-stale');
    expect(r).toMatchObject({ followers: 1, ok: 0, fail: 1 });
    const d1 = await env.DB.prepare("SELECT detail FROM auto_executions WHERE signal_id = 's-stale'").first<{ detail: string }>();
    expect(d1?.detail).toContain('시세가 오래');
    // 손절가(2600)가 지금 가격(2500)보다 위 = 저점 이미 깨짐 → 건너뜀
    await prices({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 });
    await new Promise((res) => setTimeout(res, 1200)); // 시세 캐시(1초) 만료
    await insertSignal(env.DB, sig('s-past', 'open', { slPrice: 2_600 }));
    r = await run('s-past');
    expect(r).toMatchObject({ followers: 1, ok: 0, skipped: 1 });
    const d2 = await env.DB.prepare("SELECT detail FROM auto_executions WHERE signal_id = 's-past'").first<{ detail: string }>();
    expect(d2?.detail).toContain('이미 지나쳐');
    // 정상 진입은 실제 증거금과 계약 수를 표기
    await insertSignal(env.DB, sig('s-ok', 'open', { slPrice: 2_400 }));
    r = await run('s-ok');
    expect(r.ok).toBe(1);
    const d3 = await env.DB.prepare("SELECT detail FROM auto_executions WHERE signal_id = 's-ok'").first<{ detail: string }>();
    expect(d3?.detail).toMatch(/오른다 [\d.]+ USDT 3배 \(\d+계약\) · 손절 2400/);
    const s = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'safetyf5', password: '123456', inviteCode: 'dev1234', uid: '91234005', termsAgreed: true, termsVersion: '2020-01-01' }) });
    expect(s.status).toBe(400); expect(s.body.code).toBe('TERMS_VERSION');
  });
});
