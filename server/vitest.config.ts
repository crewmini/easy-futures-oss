import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// 테스트는 workerd(miniflare) 안에서 돈다: D1·Durable Object 가 진짜처럼 동작하고 WebCrypto 도 그대로다.
// 실제 네트워크는 쓰지 않는다(PAPER_FEED=off, 시세는 테스트에서 직접 주입).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            MASTER_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            INVITE_CODE: 'dev1234',
            PAPER_FEED: 'off',
            ALLOW_PAPER: 'on', // 연습 모드는 제품에서 빠졌지만(2026-09-18) 테스트는 연습 엔진으로 돈다 — 새 사용자 기본 paper + 누구나 paper 전환 허용
            TELEGRAM_BOT_TOKEN: 'test-token',
            ADMIN_LOGIN_IDS: 'adminuser,cmaster1,cmaster2,cmaster3,cmaster4,cmaster5,cmaster6', // 연습 고수 감시는 관리자 계정만 (copy.test 의 연습 고수들)
            TELEGRAM_ADMIN_CHAT_ID: '42',
            TELEGRAM_API_BASE: 'https://telegram.test',
            BOT_CANDLE_URL: 'https://candles.test/info',
            BOT_WEBHOOK_BASE: 'https://bot.test',
            CANONICAL_HOST: '', // 테스트는 어느 호스트로 불러도 리다이렉트 없이
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['src/**/*.test.ts'],
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
