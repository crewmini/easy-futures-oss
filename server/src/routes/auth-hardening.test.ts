// 인증 경로 2차 보강 (감사 B8·B9·B10): IP 당 로그인 실패 제한, 임시 비밀번호 24시간 만료, 텔레그램 웹훅 본문 크기
import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TERMS_VERSION } from '@easy-futures/shared';
import { createUser, findUserById, setPassword, LOGIN_IP_MAX_FAILS } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';

const BASE = 'http://localhost/api';
async function login(loginId: string, password: string, ip: string) {
  const res = await SELF.fetch(BASE + '/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } });
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookie: set ? set.split(';')[0] : '' };
}
async function mkUser(loginId: string, uid: string) {
  const salt = randomSalt();
  return createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
}

describe('login IP rate limit (B8)', () => {
  it(`allows ${LOGIN_IP_MAX_FAILS} failures per IP then answers 429, other IPs unaffected`, async () => {
    const ip = '203.0.113.9';
    for (let i = 1; i <= LOGIN_IP_MAX_FAILS; i++) {
      const r = await login(`nouser${i}`, 'wrongpw', ip);   // 아이디를 바꿔 가며 → 아이디 잠금(423)엔 안 걸리고 IP 만 쌓인다
      expect(r.status, `attempt ${i}`).toBe(401);
    }
    const blocked = await login('nouser99', 'wrongpw', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
    // 같은 IP 는 맞는 비밀번호여도 창이 끝날 때까지 막힘, 다른 IP 는 정상
    await mkUser('ipok1', '90000001');
    expect((await login('ipok1', '123456', ip)).status).toBe(429);
    expect((await login('ipok1', '123456', '198.51.100.1')).status).toBe(200);
  }, 60_000);

  it('does not count successful logins', async () => {
    await mkUser('ipok2', '90000002');
    for (let i = 0; i < 3; i++) expect((await login('ipok2', '123456', '198.51.100.2')).status).toBe(200);
    const row = await env.DB.prepare('SELECT count FROM login_ip_attempts WHERE ip = ?').bind('198.51.100.2').first<{ count: number }>();
    expect(row).toBeNull();
  });
});

describe('temp password expiry (B9)', () => {
  let userId = 0;
  beforeAll(async () => { userId = (await mkUser('tempuser', '90000003')).id; });

  it('admin temp password works within 24h and carries mustChangePassword', async () => {
    const salt = randomSalt();
    await setPassword(env.DB, userId, await pbkdf2Hash('00001111', salt), salt, true);
    const u = await findUserById(env.DB, userId);
    expect(u!.must_change_pw).toBe(1);
    expect(u!.pw_temp_expires_at).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const r = await login('tempuser', '00001111', '198.51.100.3');
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true);
  });

  it('after expiry login is 403 TEMP_PW_EXPIRED; a wrong password is still 401', async () => {
    await env.DB.prepare('UPDATE users SET pw_temp_expires_at = ? WHERE id = ?').bind(Date.now() - 1000, userId).run();
    const r = await login('tempuser', '00001111', '198.51.100.3');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TEMP_PW_EXPIRED');
    expect((await login('tempuser', 'wrongpw', '198.51.100.3')).status).toBe(401);
  });

  it('setting a real password clears the expiry', async () => {
    await env.DB.prepare('UPDATE users SET pw_temp_expires_at = ? WHERE id = ?').bind(Date.now() + 3_600_000, userId).run();
    const first = await login('tempuser', '00001111', '198.51.100.3');
    expect(first.status).toBe(200);
    const res = await SELF.fetch(BASE + '/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: '00001111', newPassword: 'newpw123' }), headers: { 'content-type': 'application/json', cookie: first.cookie } });
    expect(res.status).toBe(200);
    const u = await findUserById(env.DB, userId);
    expect(u!.must_change_pw).toBe(0);
    expect(u!.pw_temp_expires_at).toBeNull();
    expect((await login('tempuser', 'newpw123', '198.51.100.3')).status).toBe(200);
  });
});

describe('telegram webhook body size (B10)', () => {
  const post = (path: string, size: number) => SELF.fetch(BASE + path, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(size) }), headers: { 'content-type': 'application/json' } });
  it('accepts a 100KB webhook body (old 16KB gate no longer applies) and answers 200 above 256KB', async () => {
    expect((await post('/telegram/whatever', 100 * 1024)).status).toBe(401);   // 크기 통과 → 시크릿 검사에서 거절
    const big = await post('/telegram/whatever', 300 * 1024);
    expect(big.status).toBe(200);
    expect(((await big.json()) as { dropped?: string }).dropped).toBe('too_large');
  });
  it('other routes keep the 16KB limit', async () => {
    expect((await post('/auth/login', 100 * 1024)).status).toBe(413);
  });
});
