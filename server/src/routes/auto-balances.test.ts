// 관리자 AI 자동매매 카드: 승인 사용자 실시간 선물 잔고 — 연습 사용자는 연습 엔진 지갑, 관리자만 조회
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { AUTO_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import type { AdminAutoBalancesResponse } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { applyAuto, setAutoStatus } from '../auto/db.js';

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
async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
const login = (loginId: string) => call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password: '123456' }) });

describe('admin auto balances', () => {
  beforeEach(() => { cookie = ''; });

  it('returns the approved paper user wallet from the paper engine', async () => {
    const id = await mkUser('balpaper', '91235001');
    await applyAuto(env.DB, id, { enabled: true, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }, AUTO_TERMS_VERSION);
    expect(await setAutoStatus(env.DB, id, 'approved', 'admin', null)).toBe(true);
    await mkUser('adminuser', '91235002');
    expect((await login('adminuser')).status).toBe(200);
    const r = await call('/admin/auto/balances');
    expect(r.status).toBe(200);
    const body = r.body as unknown as AdminAutoBalancesResponse;
    expect(body.cachedAt).toBeGreaterThan(0);
    expect(body.serverTime).toBeGreaterThanOrEqual(body.cachedAt);
    const me = body.balances.find((b) => b.userId === id);
    expect(me).toBeDefined();
    expect(me!.loginId).toBe('balpaper');
    expect(me!.mode).toBe('paper');
    expect(me!.error).toBeNull();
    expect(me!.wallet?.currency).toBe('USDT');
    expect(me!.wallet?.equity).toBe(1000); // PAPER_START_BALANCE 기본값
    expect(me!.wallet?.available).toBe(1000);
    expect(me!.positions).toEqual([]);
    // 응답에 비밀키 성격의 필드가 섞여 있지 않은지
    expect(JSON.stringify(body)).not.toMatch(/secret|apiKey|api_key/i);
  });

  it('rejects non-admin users with 403', async () => {
    await mkUser('balplain', '91235003');
    expect((await login('balplain')).status).toBe(200);
    const r = await call('/admin/auto/balances');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });
});
