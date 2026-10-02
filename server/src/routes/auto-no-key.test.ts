// AI 자동매매 켜기: 실거래인데 API 키가 없으면 400 NO_API_KEY (감사 2026-09-18 C1 — "켜져 있어요"인데 신호를 전부 건너뛰는 상태 방지)
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
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

describe('auto settings: enabling needs an API key on live', () => {
  it('rejects enabled:true without key (400 NO_API_KEY) and keeps it off; turning off still works', async () => {
    const salt = randomSalt();
    const u = await createUser(env, 'autonokey', await pbkdf2Hash('123456', salt), salt, '91232333', Date.now(), TERMS_VERSION);
    await env.DB.prepare("UPDATE users SET kyc_status = 'approved', auto_status = 'approved' WHERE id = ?").bind(u.id).run();
    await env.DB.prepare("INSERT INTO settings (user_id, mode) VALUES (?, 'live') ON CONFLICT(user_id) DO UPDATE SET mode = 'live'").bind(u.id).run();
    let r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'autonokey', password: '123456' }) });
    expect(r.status).toBe(200);
    r = await call('/auto/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(r.status).toBe(400); expect(r.body.code).toBe('NO_API_KEY');
    const row = await env.DB.prepare('SELECT enabled FROM auto_settings WHERE user_id = ?').bind(u.id).first<{ enabled: number }>();
    expect(row?.enabled ?? 0).toBe(0);
    r = await call('/auto/settings', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(r.status).toBe(200); expect(r.body.enabled).toBe(false);
  });
});
