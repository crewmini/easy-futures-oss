// 인증 없이 열린 경로: /api/health, /api/klines
import { Hono } from 'hono';
import type { Kline } from '@easy-futures/shared';
import type { AppEnv } from '../auth.js';
import { badRequest } from '../errors.js';
import { parseSymbol } from '../validate.js';
import { WooxClient } from '../woox/client.js';

const STEPS = new Set([1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440]);

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/health', (c) => c.json({ ok: true, serverTime: Date.now() }));

publicRoutes.get('/klines', async (c) => {
  // 공개 K선은 사용자마다 같은 값 → 엣지 캐시 30초 (거래소 공개 API 보호, 요청 수 절감)
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const symbol = parseSymbol(c.req.query('symbol'));
  const step = Number(c.req.query('step') ?? 15);
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 96) || 96));
  if (!STEPS.has(step)) throw badRequest('step 이 올바르지 않아요', 'BAD_STEP');
  const end = Math.floor(Date.now() / 1000);
  const start = end - step * 60 * limit;
  const rows = await new WooxClient().getKlines(symbol, step, start, end);
  const out: Kline[] = rows.map((k) => ({
    t: Number(k.timestamp) * 1000,
    o: Number(k.open_price),
    h: Number(k.high_price),
    l: Number(k.low_price),
    c: Number(k.close_price),
    v: Number(k.volume),
  }));
  const res = c.json(out.slice(-limit));
  res.headers.set('Cache-Control', 'public, max-age=30');
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});
