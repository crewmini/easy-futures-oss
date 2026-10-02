// 공개 시세 WebSocket 직결 (CORS 무관). 서버 폴링보다 빠른 현재가 갱신용.
import type { Price, Symbol } from '@easy-futures/shared';
import { SYMBOLS } from '@easy-futures/shared';

const WS_URL = 'wss://cloud-ws.wooxpro.com/api?protocol=1.1';
type Listener = (symbol: Symbol, price: Price) => void;

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let pingTimer: number | undefined;
let reconnectTimer: number | undefined;
let backoff = 1000;
let lastMsgAt = 0;
export const latest: Partial<Record<Symbol, Price>> = {};

function schedulePing() {
  window.clearTimeout(pingTimer);
  pingTimer = window.setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
    schedulePing();
  }, 15000);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(WS_URL); } catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    backoff = 1000;
    ws?.send(JSON.stringify({ action: 'subscribe', args: SYMBOLS.map((s) => `futures/ticker:${s}`) }));
    schedulePing();
  };
  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    if (typeof ev.data !== 'string') return;
    if (ev.data === 'pong') return;
    let msg: { group?: string; data?: Record<string, string> };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.group?.startsWith('futures/ticker:') || !msg.data) return;
    const symbol = msg.data.symbol as Symbol;
    if (!SYMBOLS.includes(symbol)) return;
    const last = Number(msg.data.last_price);
    const mark = Number(msg.data.mark_price ?? msg.data.last_price);
    if (!isFinite(last)) return;
    const range = Number(msg.data.range);
    const price: Price = { last, mark: isFinite(mark) ? mark : last, updatedAt: Date.now(), change24hPct: isFinite(range) ? range * 100 : undefined };
    latest[symbol] = price;
    listeners.forEach((l) => l(symbol, price));
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  window.clearTimeout(pingTimer);
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => { backoff = Math.min(backoff * 2, 15000); connect(); }, backoff);
}

export function subscribeTicker(l: Listener): () => void {
  listeners.add(l);
  connect();
  return () => { listeners.delete(l); };
}
export function tickerAlive(): boolean { return Date.now() - lastMsgAt < 30000; }
