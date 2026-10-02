// easy-futures API — Cloudflare Worker 진입점 (Hono). docs/api-contract.md v0.2
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './auth.js';
import { HttpError } from './errors.js';
import { log } from './log.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { adminRoutes, kycRoutes } from './routes/kyc.js';
import { adminPartnerRoutes, partnerApplyRoutes, partnerRoutes } from './routes/partner.js';
import { adminAutoRoutes, autoRoutes, signalRoutes } from './routes/auto.js';
import { adminBotRoutes } from './routes/bot.js';
import { adminCopyRoutes, copyRoutes } from './routes/copy.js';
import { kickMasters } from './copy/MasterWatcher.js';
import { runRetention } from './maintenance.js';
import { telegramRoutes } from './bot/webhook.js';
import { publicRoutes } from './routes/public.js';
import { tradeRoutes } from './routes/trade.js';
import { WooxError } from './woox/client.js';

export { PaperEngine } from './paper/PaperEngine.js';
export { AutoTrader } from './auto/AutoTrader.js';
export { BottomWatcher } from './bot/BottomWatcher.js';
export { MasterWatcher } from './copy/MasterWatcher.js';
export { CopyTrader } from './copy/CopyTrader.js';
export { RateGate } from './woox/RateGate.js';

const api = new Hono<AppEnv>();
// 응답 보안 헤더: 인증된 JSON 은 캐시 금지
api.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Referrer-Policy', 'no-referrer');
});
// 요청 본문 크기 제한: 신분증 사진(2MB) 외에는 16KB
api.use('/kyc', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: '사진이 너무 커요. 다시 찍어 주세요', code: 'BODY_TOO_LARGE' }, 413) }));
api.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/kyc')) return next();
  // 텔레그램 웹훅은 256KB 까지, 넘어도 200 — 413 이면 텔레그램이 같은 update 를 계속 재전송해 ✅ 버튼 처리가 밀린다 (감사 B10)
  if (c.req.path.startsWith('/api/telegram/')) return bodyLimit({ maxSize: 256 * 1024, onError: (cc) => cc.json({ ok: true, dropped: 'too_large' }) })(c, next);
  return bodyLimit({ maxSize: 16 * 1024, onError: (cc) => cc.json({ error: '요청이 너무 커요', code: 'BODY_TOO_LARGE' }, 413) })(c, next);
});
api.route('/', publicRoutes);
api.route('/auth', authRoutes);
api.route('/keys', keyRoutes);
api.route('/kyc', kycRoutes);
api.route('/signals', signalRoutes);
api.route('/auto', autoRoutes);
api.route('/admin/auto', adminAutoRoutes);
api.route('/admin/bot', adminBotRoutes);
api.route('/copy', copyRoutes);
api.route('/admin/copy', adminCopyRoutes);
api.route('/telegram', telegramRoutes);
api.route('/admin/partners', adminPartnerRoutes);
api.route('/admin', adminRoutes);
api.route('/partner/apply', partnerApplyRoutes);
api.route('/partner', partnerRoutes);
api.route('/', tradeRoutes);
// 주의: api.notFound 는 app.route() 로 옮겨지지 않는다(Hono) — 없는 /api/* 는 아래 app.all('*') 에서 JSON 404 로 돌려준다 (감사 B4)

const app = new Hono<AppEnv>();
// 정식 주소로 이전(2026-09-07): CANONICAL_HOST(wrangler.toml [vars])가 있으면 workers.dev·www 로 온 화면은 정식 주소로 보내고 API 는 안내로 거절.
// 비워 두면 아무 주소에서나 그대로 동작한다 (다른 Cloudflare 계정에 올리는 개발 서버용)
app.use('*', async (c, next) => {
  const canonical = (c.env.CANONICAL_HOST ?? '').trim();
  if (!canonical) return next();
  const url = new URL(c.req.url);
  if (url.hostname.endsWith('.workers.dev') || url.hostname === 'www.' + canonical) {
    if (url.pathname.startsWith('/api/')) {
      return c.json({ error: `주소가 바뀌었어요. https://${canonical} 에서 다시 로그인해 주세요`, code: 'MOVED' }, 410);
    }
    url.hostname = canonical;
    return c.redirect(url.toString(), 301);
  }
  await next();
});
app.route('/api', api);

// 라우트에 안 잡힌 나머지: /api/* 는 (없는 주소든, 있는 주소의 다른 메서드든) JSON 404 — SPA HTML 200 으로 떨어지면 웹 req() 가 null 을 받아 화면이 깨진다(감사 B4).
// 그 밖의 경로는 정적 자산(assets 바인딩). run_worker_first=["/api/*"] 라 운영에서는 거의 오지 않는다.
app.all('*', async (c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: '없는 주소예요', code: 'NOT_FOUND' }, 404);
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: '없는 주소예요', code: 'NOT_FOUND' }, 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, code: err.code, detail: err.detail }, err.status as ContentfulStatusCode);
  }
  if (err instanceof WooxError) {
    log.warn('exchange error', { path: err.path, code: err.code, http: err.httpStatus, message: err.message });
    if (err.httpStatus === 429) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((err.retryAfterMs ?? 5000) / 1000))));   // 거래소가 알려 준 대기 시간(감사 B1)
      return c.json({ error: '거래소가 잠시 바빠요. 10초 뒤 다시 눌러 주세요', code: 'RATE_LIMITED' }, 503);
    }
    return c.json({ error: `거래소가 요청을 거절했어요 (${err.message})`, code: err.code }, 502);
  }
  log.error('unhandled', err);
  return c.json({ error: '서버에 문제가 생겼어요. 잠시 후 다시 해 주세요', code: 'INTERNAL' }, 500);
});

/** 크론(매분): 저점 봇 감시 루프의 알람이 죽어 있으면 되살린다. 매시 7분에는 오래된 기록 보존 정리(감사 A12) */
async function scheduled(ev: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<void> {
  if (new Date(ev.scheduledTime).getUTCMinutes() === 7) ctx.waitUntil(runRetention(env).catch((e) => log.warn('retention failed', { message: (e as Error).message })));
  ctx.waitUntil(env.BOT.get(env.BOT.idFromName('global')).fetch('https://bot/kick', { method: 'POST' }).catch((e) => log.warn('bot kick failed', { message: (e as Error).message })));
  ctx.waitUntil(kickMasters(env).catch((e) => log.warn('copy master kick failed', { message: (e as Error).message })));
  // 시세 DO(PaperEngine)도 매분 한 번 깨운다 — 알람이 죽어 있으면 /prices 가 다시 건다 (감사 A4). 실거래 주문·손실 판정이 전부 이 시세에 기댄다
  ctx.waitUntil(env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/prices').then(() => undefined).catch((e) => log.warn('paper kick failed', { message: (e as Error).message })));
}

export default { fetch: app.fetch, scheduled };
