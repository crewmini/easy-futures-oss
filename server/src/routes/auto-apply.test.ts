// 자동매매 신청: 특약 버전 동의 필수, 비율 30%·배율 50배·손절 30% 상한
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { AUTO_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { env } from 'cloudflare:test';
import { pbkdf2Hash, randomSalt } from '../crypto.js';

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

describe('auto apply', () => {
  it('requires auto terms version and enforces limits', async () => {
    const salt = randomSalt();
    const u = await createUser(env, 'applyuser', await pbkdf2Hash('123456', salt), salt, '91232222', Date.now(), TERMS_VERSION);
    await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
    let r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'applyuser', password: '123456' }) });
    expect(r.status).toBe(200);
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, pct: 10, maxLeverage: 5, defaultSlRoi: 20 }) });
    expect(r.status).toBe(400); expect(r.body.code).toBe('AUTO_TERMS_REQUIRED');
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, autoTermsVersion: 'old', pct: 10, maxLeverage: 5, defaultSlRoi: 20 }) });
    expect(r.body.code).toBe('AUTO_TERMS_REQUIRED');
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, autoTermsVersion: AUTO_TERMS_VERSION, pct: 40, maxLeverage: 5, defaultSlRoi: 20 }) });
    expect(r.body.code).toBe('BAD_PCT');
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, autoTermsVersion: AUTO_TERMS_VERSION, pct: 30, maxLeverage: 51, defaultSlRoi: 20 }) });
    expect(r.body.code).toBe('BAD_LEV');
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, autoTermsVersion: AUTO_TERMS_VERSION, pct: 30, maxLeverage: 50, defaultSlRoi: 35 }) });
    expect(r.body.code).toBe('BAD_SL');
    r = await call('/auto/apply', { method: 'POST', body: JSON.stringify({ agree: true, autoTermsVersion: AUTO_TERMS_VERSION, pct: 30, maxLeverage: 50, defaultSlRoi: 30 }) });
    expect(r.status).toBe(200); expect(r.body.status).toBe('pending');
    const row = await env.DB.prepare('SELECT auto_terms_version, agreed_at FROM auto_settings WHERE user_id = ?').bind(u.id).first<{ auto_terms_version: string; agreed_at: number }>();
    expect(row?.auto_terms_version).toBe(AUTO_TERMS_VERSION); expect(row?.agreed_at).toBeGreaterThan(0);
  });
});
