// 텔레그램 429 → retry_after 만큼 기다렸다 한 번만 재시도 (감사 A21)
import { describe, it, expect, afterEach } from 'vitest';
import { net } from './net.js';
import { Telegram } from './telegram.js';

const realFetch = net.fetch;
afterEach(() => { net.fetch = realFetch; });

describe('Telegram.call on 429', () => {
  it('waits retry_after seconds and retries once', async () => {
    let n = 0;
    net.fetch = async () => {
      n++;
      if (n === 1) return Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }, { status: 429 });
      return Response.json({ ok: true, result: { message_id: 7 } });
    };
    const t0 = Date.now();
    const id = await new Telegram('tok', 'https://telegram.test').sendMessage(42, 'hi');
    expect(id).toBe(7);
    expect(n).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('gives up after the second 429', async () => {
    let n = 0;
    net.fetch = async () => { n++; return Response.json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }, { status: 429 }); };
    await expect(new Telegram('tok', 'https://telegram.test').call('sendMessage', {})).rejects.toThrow('Too Many Requests');
    expect(n).toBe(2);
  });
});
