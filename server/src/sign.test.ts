import { describe, it, expect } from 'vitest';
import { sign, signString, buildHeaders, signWebSocketLogin } from './sign.js';

// docs/woox-pro-api.md 예시 벡터. 기대값은 `openssl dgst -sha256 -hmac <secret>` 으로 도출.
const SECRET = '6c6c98544461bbe71db2bca4c6d7fd0021e0ba9efc215f9c6ad41852df9d9df9';
const TS = 1589793796145;
const MEMO = 'test001';
const BODY = '{"currency":"USDT","amount":"10","transferType":"spot_to_contract"}';
const EXPECTED = 'bbd57e119c53e7cd28c5097f596822173fbf883c94c8bcc9a61ec2da9e143778';

describe('sign', () => {
  it('builds the exact sign string', () => {
    expect(signString(TS, MEMO, BODY)).toBe(`${TS}#${MEMO}#${BODY}`);
  });

  it('matches the doc vector (openssl-derived)', async () => {
    expect(await sign(SECRET, TS, MEMO, BODY)).toBe(EXPECTED);
    expect(await sign(SECRET, String(TS), MEMO, BODY)).toBe(EXPECTED);
  });

  it('buildHeaders sets key, sign and timestamp', async () => {
    const h = await buildHeaders('key123', SECRET, MEMO, BODY, TS);
    expect(h['X-API-KEY']).toBe('key123');
    expect(h['X-API-SIGN']).toBe(EXPECTED);
    expect(h['X-API-TIMESTAMP']).toBe(String(TS));
  });

  it('empty body (GET without query) still signs', async () => {
    expect(await sign(SECRET, TS, MEMO, '')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('websocket login uses the fixed body', async () => {
    expect(await signWebSocketLogin(SECRET, TS, MEMO)).toBe(await sign(SECRET, TS, MEMO, 'wooxpro.WebSocket'));
  });
});
