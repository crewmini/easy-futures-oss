// 실제 의존(캔들 조회·텔레그램 발송) — BottomWatcher 와 webhook 양쪽에서 쓰므로 따로 둔다 (순환 import 방지)
import type { Env } from '../env.js';
import { fetchCandles } from './candles.js';
import type { MonitorDeps } from './monitor.js';
import { adminChatId, telegramFor } from './telegram.js';

export function realDeps(env: Env): MonitorDeps {
  const tg = telegramFor(env);
  const chat = adminChatId(env);
  return {
    fetchCandles: (coin, tf, bars) => fetchCandles(coin, tf, bars, Date.now(), env.BOT_CANDLE_URL || undefined),
    send: async (text, kb) => {
      if (!tg || !chat) throw new Error('텔레그램 미설정 (TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID)');
      return tg.sendMessage(chat, text, kb);
    },
    sendPhoto: async (png, caption, kb) => {
      if (!tg || !chat) throw new Error('텔레그램 미설정');
      return tg.sendPhoto(chat, png, caption, kb);
    },
    now: () => Date.now(),
  };
}

