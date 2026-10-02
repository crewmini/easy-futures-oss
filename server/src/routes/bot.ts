// 관리자 화면용 저점 봇 API: 현황 조회, 감시 등록/해제, 설정, 즉시 평가, 웹훅 재등록
import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from '../auth.js';
import { badRequest, HttpError } from '../errors.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import * as store from '../bot/db.js';
import { COIN_SYMBOL } from '../bot/signals.js';
import { SUPPORTED_TFS } from '../bot/strategy.js';
import { adminChatId, telegramFor } from '../bot/telegram.js';
import { isAdmin } from './auth.js';

export const adminBotRoutes = new Hono<AppEnv>();
adminBotRoutes.use('*', authMiddleware, async (c, next) => {
  if (!isAdmin(c.env, c.get('ctx').user.loginId)) throw new HttpError(403, '관리자만 볼 수 있어요', 'FORBIDDEN');
  await next();
});
const stub = (env: AppEnv['Bindings']) => env.BOT.get(env.BOT.idFromName('global'));

adminBotRoutes.get('/', async (c) => {
  const [watches, chains, states, settings, doStatus] = await Promise.all([
    store.listWatches(c.env.DB), store.listActiveChains(c.env.DB), store.listWatchState(c.env.DB), store.getBotSettings(c.env.DB),
    stub(c.env).fetch('https://bot/status').then((r) => r.json()).catch(() => null), // 조회만으로도 알람이 되살아난다
  ]);
  return c.json({ telegramConfigured: !!c.env.TELEGRAM_BOT_TOKEN, adminChatConfigured: adminChatId(c.env) !== null, supportedCoins: Object.keys(COIN_SYMBOL), supportedTfs: SUPPORTED_TFS, watches, chains, states, settings, engine: doStatus });
});
adminBotRoutes.post('/watch', async (c) => {
  const b = await readJson(c);
  const coin = String(b.coin ?? '').toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) throw badRequest('코인 이름이 이상해요', 'BAD_COIN');
  if (b.action === 'remove') { await store.removeWatch(c.env.DB, coin); log.info('bot watch remove', { coin, by: c.get('ctx').user.loginId }); return c.json({ ok: true }); }
  const tfs = [...new Set(Array.isArray(b.tfs) && b.tfs.length ? b.tfs.map(String) : ['15m', '1h', '4h'])];
  if (tfs.some((t: string) => !SUPPORTED_TFS.includes(t))) throw badRequest('지원하지 않는 타임프레임', 'BAD_TF');
  try { await store.addWatch(c.env.DB, coin, tfs); } catch (e) { throw badRequest((e as Error).message, 'WATCH_LIMIT'); }
  log.info('bot watch add', { coin, tfs, by: c.get('ctx').user.loginId });
  c.executionCtx.waitUntil(stub(c.env).fetch('https://bot/kick', { method: 'POST' }).catch(() => null));
  return c.json({ ok: true });
});
adminBotRoutes.put('/settings', async (c) => {
  const b = await readJson(c);
  const by = c.get('ctx').user.loginId;
  const set = async (key: 'relay' | 'leverage' | 'tpR' | 'tfs', value: string) => { await store.setBotSetting(c.env.DB, key, value, by); log.info('bot setting', { key, value, by }); };
  if ('relay' in b) await set('relay', b.relay === true ? 'on' : 'off');
  if ('leverage' in b) { const n = Number(b.leverage); if (!(Number.isInteger(n) && n >= 1 && n <= 50)) throw badRequest('배율은 1~50', 'BAD_LEV'); await set('leverage', String(n)); }
  if ('tpR' in b) { const n = Number(b.tpR); if (!(n >= 0 && n <= 10)) throw badRequest('익절 R배수는 0~10', 'BAD_TPR'); await set('tpR', String(n)); }
  if ('tfs' in b) { const tfs = [...new Set(Array.isArray(b.tfs) ? b.tfs.map(String) : [])]; if (tfs.some((t: string) => !SUPPORTED_TFS.includes(t))) throw badRequest('지원하지 않는 타임프레임', 'BAD_TF'); await set('tfs', tfs.join(' ')); }
  return c.json(await store.getBotSettings(c.env.DB));
});
adminBotRoutes.post('/poll', async (c) => { log.info('bot poll now', { by: c.get('ctx').user.loginId }); return c.json(await stub(c.env).fetch('https://bot/poll', { method: 'POST' }).then((r) => r.json())); });
/** 텔레그램이 보는 웹훅 상태 (전달 오류·대기 건수). 주소의 비밀 부분은 가린다 */
adminBotRoutes.get('/webhook', async (c) => {
  const tg = telegramFor(c.env);
  if (!tg) return c.json({ configured: false });
  const info = await tg.getWebhookInfo() as { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string; ip_address?: string };
  return c.json({ configured: true, url: (info.url ?? '').replace(/\/api\/telegram\/.*$/, '/api/telegram/***'), pendingUpdates: info.pending_update_count ?? 0, lastErrorAt: info.last_error_date ? info.last_error_date * 1000 : null, lastError: info.last_error_message ?? null });
});
adminBotRoutes.post('/webhook', async (c) => { log.info('bot webhook re-register', { by: c.get('ctx').user.loginId }); return c.json(await stub(c.env).fetch('https://bot/webhook', { method: 'POST' }).then((r) => r.json())); });
