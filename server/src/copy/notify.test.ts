// 카피 운영 알림: 관리자 텔레그램 10분 중복 제거(copy_flags), 미설정이면 무동작, 절대 던지지 않음 + 슬리피지 부호 + 정리 사유 분류
import { describe, it, expect, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { slippagePctOf } from './db.js';
import { classifyCloseOrders } from './MasterWatcher.js';
import { notifyAdmin, notifyDeps, NOTIFY_DEDUPE_MS } from './notify.js';

const realSend = notifyDeps.send;
afterEach(() => { notifyDeps.send = realSend; });

describe('notifyAdmin', () => {
  it('sends once per key within 10 minutes, prefixes [카피], caps at 600 chars, never throws', async () => {
    const sent: { chatId: number; text: string }[] = [];
    notifyDeps.send = async (_env, chatId, text) => { sent.push({ chatId, text }); };
    expect(await notifyAdmin(env, '손실 한도 도달 — 팔로워 ab***2', { key: 'loss:1' })).toBe(true);
    expect(await notifyAdmin(env, '손실 한도 도달 — 팔로워 ab***2 (다시)', { key: 'loss:1' })).toBe(false);   // 같은 key → 10분 안에는 보내지 않음
    expect(await notifyAdmin(env, '다른 팔로우', { key: 'loss:2' })).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ chatId: 42, text: '[카피] 손실 한도 도달 — 팔로워 ab***2' });
    // 10분이 지난 것처럼 flag 를 과거로 돌리면 다시 보낸다
    await env.DB.prepare("UPDATE copy_flags SET value = ? WHERE key = 'notify:loss:1'").bind(String(Date.now() - NOTIFY_DEDUPE_MS - 1)).run();
    expect(await notifyAdmin(env, '세 번째', { key: 'loss:1' })).toBe(true);
    expect(sent).toHaveLength(3);
    // key 없이는 매번, 600자 상한
    expect(await notifyAdmin(env, 'x'.repeat(1000))).toBe(true);
    expect(sent[3].text.length).toBe(600);
    // 전송 실패는 삼킨다
    notifyDeps.send = async () => { throw new Error('telegram down'); };
    expect(await notifyAdmin(env, '실패해도 던지지 않음')).toBe(false);
  });

  it('is a no-op when telegram is not configured', async () => {
    let n = 0;
    notifyDeps.send = async () => { n++; };
    expect(await notifyAdmin({ ...env, TELEGRAM_BOT_TOKEN: undefined }, '토큰 없음')).toBe(false);
    expect(await notifyAdmin({ ...env, TELEGRAM_ADMIN_CHAT_ID: '' }, 'chat 없음')).toBe(false);
    expect(n).toBe(0);
  });
});

describe('slippagePctOf (positive = worse for the follower)', () => {
  it('entry long: paid more → +, entry short: sold lower → +, close long: sold lower → +, close short: bought higher → +', () => {
    expect(slippagePctOf('open', 'long', 100, 101)).toBeCloseTo(1, 6);
    expect(slippagePctOf('add', 'long', 100, 99)).toBeCloseTo(-1, 6);
    expect(slippagePctOf('open', 'short', 100, 99)).toBeCloseTo(1, 6);
    expect(slippagePctOf('close', 'long', 100, 99)).toBeCloseTo(1, 6);
    expect(slippagePctOf('reduce', 'long', 100, 101)).toBeCloseTo(-1, 6);
    expect(slippagePctOf('close', 'short', 100, 101)).toBeCloseTo(1, 6);
    expect(slippagePctOf('open', 'long', 100, 100)).toBe(0);
    expect(slippagePctOf('tpsl', 'long', 100, 101)).toBeNull();
    expect(slippagePctOf('open', 'long', 0, 101)).toBeNull();
    expect(slippagePctOf('open', 'long', 100, null)).toBeNull();
  });
});

describe('classifyCloseOrders', () => {
  it('liquidate/bankruptcy → liquidation, adl → adl, plain/entry orders → normal', () => {
    expect(classifyCloseOrders([])).toBe('normal');
    expect(classifyCloseOrders([{ type: 'market', side: 3 }, { type: 'planorder', side: 3 }])).toBe('normal');
    expect(classifyCloseOrders([{ type: 'liquidate', side: 1 }])).toBe('normal');   // 진입 쪽 주문은 무시
    expect(classifyCloseOrders([{ type: 'market', side: 3 }, { type: 'liquidate', side: 3 }])).toBe('liquidation');
    expect(classifyCloseOrders([{ type: 'bankruptcy', side: 2 }])).toBe('liquidation');
    expect(classifyCloseOrders([{ type: 'adl', side: 3 }])).toBe('adl');
    expect(classifyCloseOrders([{ type: 'adl', side: 3 }, { type: 'LIQUIDATE', side: 3 }])).toBe('liquidation');
  });
});
