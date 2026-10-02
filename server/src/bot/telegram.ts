// 텔레그램 Bot API 얇은 클라이언트 (fetch). 토큰이 없으면 null — 봇 기능만 비활성.
import { sha256Hex } from '../crypto.js';
import type { Env } from '../env.js';
import { net } from './net.js';

export interface InlineButton { text: string; callback_data: string }
export type InlineKeyboard = InlineButton[][];
export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; caption?: string };
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: { message_id: number; chat: { id: number }; text?: string; caption?: string } };
}

export class Telegram {
  constructor(private token: string, private base = 'https://api.telegram.org') {}
  async call<T = unknown>(method: string, body: Record<string, unknown>, retried = false): Promise<T> {
    const res = await net.fetch(`${this.base}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (res.status === 429 && !retried) {
      // 텔레그램이 알려 준 만큼(최대 30초) 기다렸다 한 번만 다시 (감사 A21). 바로 다시 두드리면 제한만 길어진다
      const waitSec = Math.min(30, Math.max(1, Math.floor(Number(j.parameters?.retry_after) || 1)));
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return this.call<T>(method, body, true);
    }
    if (!res.ok || !j.ok) throw new Error(`telegram ${method} 실패: ${j.description ?? res.status}`);
    return j.result as T;
  }
  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard | null, silent = false): Promise<number> {
    const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, disable_notification: silent, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
    return r.message_id;
  }
  /** 사진 + 캡션 + 버튼 (multipart). 캡션은 1024자 제한 */
  async sendPhoto(chatId: number, png: Uint8Array, caption: string, keyboard?: InlineKeyboard | null): Promise<number> {
    const fd = new FormData();
    fd.set('chat_id', String(chatId)); fd.set('caption', caption.slice(0, 1024));
    if (keyboard) fd.set('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    fd.set('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
    const res = await net.fetch(`${this.base}/bot${this.token}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id: number }; description?: string };
    if (!res.ok || !j.ok || !j.result) throw new Error(`telegram sendPhoto 실패: ${j.description ?? res.status}`);
    return j.result.message_id;
  }
  answerCallback(id: string, text?: string): Promise<unknown> { return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => null); }
  editText(chatId: number, msgId: number, text: string, keyboard?: InlineKeyboard | null): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: msgId, text, reply_markup: { inline_keyboard: keyboard ?? [] } }).catch(() => null);
  }
  editCaption(chatId: number, msgId: number, caption: string, keyboard?: InlineKeyboard | null): Promise<unknown> {
    return this.call('editMessageCaption', { chat_id: chatId, message_id: msgId, caption: caption.slice(0, 1024), reply_markup: { inline_keyboard: keyboard ?? [] } }).catch(() => null);
  }
  clearKeyboard(chatId: number, msgId: number): Promise<unknown> { return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => null); }
  setWebhook(url: string, secretToken: string): Promise<unknown> { return this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }); }
  getWebhookInfo(): Promise<{ url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string }> { return this.call('getWebhookInfo', {}); }
  setCommands(commands: { command: string; description: string }[]): Promise<unknown> { return this.call('setMyCommands', { commands }).catch(() => null); }
}

export function telegramFor(env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_API_BASE'>): Telegram | null {
  return env.TELEGRAM_BOT_TOKEN ? new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE || undefined) : null;
}
export function adminChatId(env: Pick<Env, 'TELEGRAM_ADMIN_CHAT_ID'>): number | null {
  const n = Number(env.TELEGRAM_ADMIN_CHAT_ID);
  return Number.isFinite(n) && n !== 0 ? n : null;
}
/** 웹훅 경로는 봇 토큰의 해시에서 파생 — 별도 시크릿 없이 추측 불가 */
export async function webhookSecret(token: string): Promise<string> {
  return (await sha256Hex(`ef-telegram-webhook:${token}`)).slice(0, 40);
}
/** 헤더(X-Telegram-Bot-Api-Secret-Token)는 경로와 '다른' 값 — 경로가 새어도(로그·관리자 화면) 헤더 없이는 위조 불가 (감사 보안 H1) */
export async function webhookHeaderSecret(token: string): Promise<string> {
  return (await sha256Hex(`ef-telegram-header:${token}`)).slice(0, 40);
}
export function kst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export function fmtPx(v: number): string { return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toLocaleString('en-US', { maximumSignificantDigits: 4 }); }
