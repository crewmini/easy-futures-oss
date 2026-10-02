import { describe, it, expect } from 'vitest';
import { aesDecrypt, aesEncrypt, pbkdf2Hash, randomSalt, randomToken, timingSafeEqual, toBase64, randomBytes } from './crypto.js';

const MASTER = toBase64(randomBytes(32));

describe('crypto', () => {
  it('aes encrypt/decrypt roundtrip with fresh iv each time', async () => {
    const pt = JSON.stringify({ apiKey: 'k', apiSecret: 's', memo: 'm' });
    const a = await aesEncrypt(MASTER, pt);
    const b = await aesEncrypt(MASTER, pt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.enc).not.toBe(b.enc);
    expect(await aesDecrypt(MASTER, a.enc, a.iv)).toBe(pt);
    expect(await aesDecrypt(MASTER, b.enc, b.iv)).toBe(pt);
  });

  it('aes rejects a wrong key', async () => {
    const other = toBase64(randomBytes(32));
    const { enc, iv } = await aesEncrypt(MASTER, 'hello');
    await expect(aesDecrypt(other, enc, iv)).rejects.toBeTruthy();
  });

  it('aes rejects a key that is not 32 bytes', async () => {
    await expect(aesEncrypt(toBase64(randomBytes(16)), 'x')).rejects.toThrow(/32/);
  });

  it('pbkdf2 is deterministic for same salt and differs for other salt/password', async () => {
    const salt = randomSalt();
    const h1 = await pbkdf2Hash('123456', salt);
    const h2 = await pbkdf2Hash('123456', salt);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await pbkdf2Hash('1234567', salt)).not.toBe(h1);
    expect(await pbkdf2Hash('123456', randomSalt())).not.toBe(h1);
  });

  it('randomToken is base64url and unique', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
