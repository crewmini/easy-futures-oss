// CANONICAL_HOST 가 비어 있으면(다른 계정의 개발 서버) workers.dev 주소도 그대로 동작하고, 텔레그램 웹훅 주소는 설정에서만 나온다
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { webhookUrl } from './bot/BottomWatcher.js';
import type { Env } from './env.js';

describe('canonical host / webhook base', () => {
  it('no CANONICAL_HOST → workers.dev requests are served, not redirected', async () => {
    const r = await SELF.fetch('https://easy-futures.someone.workers.dev/api/health');
    expect(r.status).toBe(200);
  });
  it('webhookUrl prefers BOT_WEBHOOK_BASE, then CANONICAL_HOST, else null', () => {
    const base = { ...(env as unknown as Env), BOT_WEBHOOK_BASE: undefined, CANONICAL_HOST: undefined } as Env;
    expect(webhookUrl(base, 'abc')).toBeNull();
    expect(webhookUrl({ ...base, CANONICAL_HOST: 'example.com' }, 'abc')).toBe('https://example.com/api/telegram/abc');
    expect(webhookUrl({ ...base, CANONICAL_HOST: 'example.com', BOT_WEBHOOK_BASE: 'https://dev.example.org/' }, 'abc')).toBe('https://dev.example.org/api/telegram/abc');
  });
});
