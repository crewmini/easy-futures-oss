// 저점 봇 감시 루프 (Durable Object 싱글턴): 60초 알람으로 마감봉을 평가하고, 텔레그램 웹훅을 스스로 등록한다.
// 크론(매분)이 /kick 으로 알람을 되살린다. 텔레그램 토큰이 없으면 아무것도 보내지 않는다.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { realDeps } from './deps.js';
import { pollOnce } from './monitor.js';
import { telegramFor, webhookHeaderSecret, webhookSecret } from './telegram.js';
import { processDue } from './webhook.js';

export const POLL_MS = 60_000;
const WEBHOOK_CHECK_MS = 6 * 3_600_000;
export const BOT_COMMANDS = [
  { command: 'start', description: '봇 소개 + chat id' },
  { command: 'watch', description: '감시 등록 — /watch BTC [15m 1h 4h]' },
  { command: 'unwatch', description: '감시 해제 — /unwatch BTC' },
  { command: 'status', description: '감시목록 + 카운트 현황' },
  { command: 'count', description: '카운트 관리 — /count BTC 15m' },
  { command: 'signal', description: '차트 보기 — /signal ETH [15m]' },
  { command: 'bot', description: 'AI 자동매매 연결 설정 — /bot on|off · lev 3 · tpr 1.5 · tfs 15m · auto on|off · grace 3' },
  { command: 'close', description: 'AI 자동매매 전량 정리 신호 — /close BTC' },
  { command: 'be', description: 'AI 자동매매 본절 신호 — /be BTC' },
  { command: 'panic', description: '비상: BTC·ETH AI 자동매매 전량 정리' },
];

function mask(url: string): string { return url.replace(/\/api\/telegram\/.*$/, '/api/telegram/***'); }

/** 웹훅 주소. BOT_WEBHOOK_BASE > https://CANONICAL_HOST 순. 둘 다 없으면 null (등록하지 않는다 — 남의 서버 주소로 등록되는 사고 방지) */
export function webhookUrl(env: Env, secret: string): string | null {
  const base = (env.BOT_WEBHOOK_BASE || (env.CANONICAL_HOST ? `https://${env.CANONICAL_HOST}` : '')).replace(/\/$/, '');
  return base ? `${base}/api/telegram/${secret}` : null;
}

export class BottomWatcher extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 어떤 요청이든 알람이 죽어 있으면 되살린다 — 크론 외에 관리자 화면 열기·웹훅 등록도 루프를 깨운다
    await this.ensureAlarm();
    if (url.pathname === '/kick') return Response.json({ ok: true, alarm: await this.ctx.storage.getAlarm() });
    if (url.pathname === '/poll' && request.method === 'POST') { const busy = !!this.ticking; await this.tickOnce(); return Response.json({ ok: true, busy }); }
    if (url.pathname === '/webhook' && request.method === 'POST') { const r = await this.ensureWebhook(true); return Response.json({ ...r, url: r.url ? mask(r.url) : undefined }); }
    if (url.pathname === '/status') {
      const wh = await this.ctx.storage.get<{ at: number; url: string }>('webhook');
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), lastTick: await this.ctx.storage.get('lastTick'), webhook: wh ? { at: wh.at, url: mask(wh.url) } : null });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  private async ensureAlarm(): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur < Date.now() - POLL_MS) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    try { await this.tickOnce(); }
    catch (e) { log.error('bot tick failed', e); }
    finally { await this.ctx.storage.setAlarm(Date.now() + POLL_MS); }
  }

  /** 평가 루프는 한 번에 하나만 — 알람과 관리자 '지금 평가'가 겹치면 같은 봉을 두 번 제안한다 (감사 H2) */
  private ticking: Promise<void> | null = null;
  private tickOnce(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async tick(): Promise<void> {
    await this.ensureWebhook(false).catch((e) => log.warn('bot webhook check failed', { message: (e as Error).message }));
    await pollOnce(this.env.DB, realDeps(this.env));
    // 유예가 지난 2·3번 후보 자동 확정 + 이탈 자동 정리 (텔레그램 미설정이면 아무것도 안 함)
    await processDue(this.env).catch((e) => log.error('bot auto-confirm failed', e));
    await this.ctx.storage.put('lastTick', Date.now());
  }

  /** 웹훅 주소가 다르면 등록 (6시간마다 확인). 토큰 없으면 건너뜀 */
  private async ensureWebhook(force: boolean): Promise<{ ok: boolean; url?: string; reason?: string }> {
    const tg = telegramFor(this.env);
    if (!tg || !this.env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'no token' };
    const last = (await this.ctx.storage.get<{ at: number; url: string }>('webhook')) ?? null;
    const secret = await webhookSecret(this.env.TELEGRAM_BOT_TOKEN);
    const url = webhookUrl(this.env, secret);
    if (!url) return { ok: false, reason: '웹훅 주소 미설정 — wrangler.toml [vars] 에 CANONICAL_HOST 또는 BOT_WEBHOOK_BASE 를 넣어 주세요' };
    if (!force && last && last.url === url && Date.now() - last.at < WEBHOOK_CHECK_MS) return { ok: true, url };
    const info = await tg.getWebhookInfo();
    if (force || info.url !== url) {
      await tg.setWebhook(url, await webhookHeaderSecret(this.env.TELEGRAM_BOT_TOKEN));
      await tg.setCommands(BOT_COMMANDS);
      log.info('bot webhook set', { url: url.replace(secret, '***') });
    }
    await this.ctx.storage.put('webhook', { at: Date.now(), url });
    return { ok: true, url };
  }
}
