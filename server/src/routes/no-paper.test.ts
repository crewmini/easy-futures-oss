// 연습(paper) 모드 제품 제거 (2026-09-18): ALLOW_PAPER 가 꺼진 배포에서 일반 사용자는 실거래만, 관리자는 연습 가능.
// vitest 바인딩은 ALLOW_PAPER=on 이므로 이 파일에서만 잠시 끈다 (env 는 워커와 같은 객체).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { AppState, CopyStateResponse } from '@easy-futures/shared';
import { TERMS_VERSION } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { defaultMode } from '../env.js';
import { paperAllowed } from './auth.js';

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
const flag = env as unknown as { ALLOW_PAPER?: string };
const signupBody = (loginId: string, uid: string) => JSON.stringify({ loginId, password: '123456', uid, termsAgreed: true, termsVersion: TERMS_VERSION });

describe('no paper mode for users (ALLOW_PAPER off)', () => {
  let saved: string | undefined;
  beforeAll(async () => {
    saved = flag.ALLOW_PAPER; delete flag.ALLOW_PAPER;
    // 시세는 격리환경에 1초 캐시되므로 첫 라우트 호출 전에 한 번 주입
    await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify({ BTCUSDT: 80_000, ETHUSDT: 2_500, SOLUSDT: 100 }) });
  });
  afterAll(() => { flag.ALLOW_PAPER = saved; });
  beforeEach(() => { cookie = ''; });

  it('helpers: default mode live, paper only for admins', () => {
    expect(defaultMode({})).toBe('live');
    expect(defaultMode({ ALLOW_PAPER: 'on' })).toBe('paper');
    expect(paperAllowed({ ADMIN_LOGIN_IDS: 'adminuser' }, 'someone')).toBe(false);
    expect(paperAllowed({ ADMIN_LOGIN_IDS: 'adminuser' }, 'adminuser')).toBe(true);
    expect(paperAllowed({ ALLOW_PAPER: 'on' }, 'someone')).toBe(true);
  });

  it('new signup is live; state/history/auto/copy answer without a key (needsSetup); paper is refused', async () => {
    let r = await call('/auth/signup', { method: 'POST', body: signupBody('nopaper1', '91251001') });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('live');
    r = await call('/auth/me');
    expect(r.body.mode).toBe('live');

    r = await call('/state');
    expect(r.status).toBe(200);
    const s = r.body as unknown as AppState;
    expect(s.mode).toBe('live');
    expect(s.connected).toBe(false);
    expect(s.needsSetup).toEqual({ kyc: true, apiKey: true });
    expect(s.wallet.equity).toBe(0);
    expect(s.positions).toEqual([]);
    expect(Object.keys(s.prices)).toContain('BTCUSDT'); // 시세 자리는 항상 있다

    r = await call('/history');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    r = await call('/auto');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('none');
    r = await call('/copy');
    expect(r.status).toBe(200);
    expect((r.body as unknown as CopyStateResponse).me.eligible).toEqual({ kyc: false, live: true, apiKey: false, autoOn: false, termsCurrent: true });

    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'paper' }) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PAPER_DISABLED');
    expect(r.body.error).toBe('연습 모드는 더 이상 제공하지 않아요');
    r = await call('/paper/reset', { method: 'POST' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PAPER_DISABLED');
    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ maxLeverage: 20 }) });
    expect(r.status).toBe(200); // 모드 외 설정은 평소대로
    expect(r.body.mode).toBe('live');

    // 주문은 안내 메시지와 함께 거절 (키 없음) — 시세 검증(NO_PRICE)은 그 앞이므로 beforeAll 에서 주입해 둔다
    r = await call('/order/open', { method: 'POST', body: JSON.stringify({ symbol: 'BTCUSDT', direction: 'long', amountUsdt: 100, leverage: 5, stopLossPrice: 1 }) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NO_API_KEY');
  });

  it('admin can still switch to paper and reset', async () => {
    const salt = randomSalt();
    await createUser(env, 'adminuser', await pbkdf2Hash('123456', salt), salt, '91251002', Date.now(), TERMS_VERSION);
    let r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId: 'adminuser', password: '123456' }) });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('live'); // 관리자도 기본은 실거래
    r = await call('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'paper' }) });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('paper');
    r = await call('/paper/reset', { method: 'POST' });
    expect(r.status).toBe(200);
    r = await call('/state');
    expect(r.status).toBe(200);
    expect((r.body as unknown as AppState).mode).toBe('paper');
    expect((r.body as unknown as AppState).needsSetup).toBeUndefined();
  });
});
