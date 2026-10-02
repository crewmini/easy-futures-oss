// 세션 쿠키 인증 미들웨어 + 쿠키 헬퍼.
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './env.js';
import { getUserContext, type PartnerRow, type UserContext, SESSION_TTL_MS } from './db.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'ef_session';

export type AppEnv = { Bindings: Env; Variables: { ctx: UserContext; partner: PartnerRow } };

function isLocalhost(c: Context): boolean {
  const host = new URL(c.req.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: !isLocalhost(c), // wrangler dev(http://localhost) 에서는 Secure 를 빼야 브라우저가 저장한다
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export const LOGIN_REQUIRED = '로그인이 필요해요';

/** 세션 없으면 401. 있으면 c.get('ctx') 로 사용자 컨텍스트 제공. */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionToken(c);
  if (!token) throw new HttpError(401, LOGIN_REQUIRED, 'UNAUTHORIZED');
  // GET 은 20초 캐시, 변경 요청(POST/PUT/DELETE)은 항상 DB 에서 다시 읽는다 (다른 엣지의 오래된 모드/키로 주문 방지)
  const ctx = await getUserContext(c.env, token, c.req.method !== 'GET');
  if (!ctx) {
    clearSessionCookie(c);
    throw new HttpError(401, LOGIN_REQUIRED, 'UNAUTHORIZED');
  }
  c.set('ctx', ctx);
  await next();
};
