// 관리자 저점 봇 API — 관리자 계정으로 현황·감시 등록·설정·즉시 평가가 되는지 (관리자 화면이 부르는 순서 그대로)
import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { net } from '../bot/net.js';

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

beforeAll(async () => {
  net.fetch = async (url) => {
    if (url.startsWith('https://telegram.test/')) return Response.json({ ok: true, result: url.endsWith('getWebhookInfo') ? { url: '' } : { message_id: 1 } });
    if (url === 'https://candles.test/info') return Response.json(Array.from({ length: 240 }, (_, i) => ({ t: Date.now() - (240 - i) * 900_000 - 1000, o: '100', h: '110', l: '100', c: '105', v: '1' })));
    throw new Error(`unexpected fetch ${url}`);
  };
  const salt = randomSalt();
  await createUser(env, 'adminuser', await pbkdf2Hash('123456', salt), salt, '91230000', Date.now(), TERMS_VERSION);
});

describe('admin bot api', () => {
  it('non-admin → 403, admin → full flow', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: 'plainuser', password: '123456', inviteCode: 'dev1234', uid: '91231111', termsAgreed: true, termsVersion: TERMS_VERSION }) });
    expect(r.status).toBe(200);
    r = await call('/admin/bot');
    expect(r.status).toBe(403);
    cookie = '';
    r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'adminuser', password: '123456' }) });
    expect(r.status).toBe(200);
    expect(r.body.isAdmin).toBe(true);

    r = await call('/admin/bot');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ telegramConfigured: true, adminChatConfigured: true, watches: {}, chains: {}, settings: { relay: true, leverage: 3, tpR: 1.5, tfs: [] } });
    expect((r.body.engine as { alarm: number }).alarm).toBeGreaterThan(0); // 조회만으로 루프가 깨어남

    r = await call('/admin/bot/watch', { method: 'POST', body: JSON.stringify({ coin: 'btc', tfs: ['15m'] }) });
    expect(r.status).toBe(200);
    r = await call('/admin/bot/settings', { method: 'PUT', body: JSON.stringify({ leverage: 5, tpR: 0, relay: false }) });
    expect(r.body).toEqual({ relay: false, leverage: 5, tpR: 0, tfs: [], autoConfirm: true, graceMin: 3 });
    r = await call('/admin/bot/settings', { method: 'PUT', body: JSON.stringify({ leverage: 500 }) });
    expect(r.status).toBe(400);
    r = await call('/admin/bot/poll', { method: 'POST' });
    expect(r.status).toBe(200);
    r = await call('/admin/bot/webhook', { method: 'POST' });
    expect(r.body).toMatchObject({ ok: true });
    r = await call('/admin/bot');
    expect(r.body.watches).toEqual({ BTC: ['15m'] });
    expect((r.body.states as { coin: string; lastPollAt: number | null; lastError: string | null }[])[0]).toMatchObject({ coin: 'BTC', lastError: null });
    r = await call('/admin/bot/watch', { method: 'POST', body: JSON.stringify({ coin: 'BTC', action: 'remove' }) });
    r = await call('/admin/bot');
    expect(r.body.watches).toEqual({});
  });
});
