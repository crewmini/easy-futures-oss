// WebCrypto 기반 암호 유틸 (Cloudflare Workers / Node 20+ 공통). node:crypto 사용 금지.
const te = new TextEncoder();
const td = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** 세션 토큰: 32바이트 → base64url. */
export function randomToken(): string {
  return toBase64Url(randomBytes(32));
}

/** 비밀번호 솔트: 16바이트 base64. */
export function randomSalt(): string {
  return toBase64(randomBytes(16));
}

export const PBKDF2_ITERATIONS = 100_000;

/** PBKDF2-SHA256, 100k 반복, 32바이트 → base64. 같은 입력이면 항상 같은 값. */
export async function pbkdf2Hash(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(saltB64), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

async function importAesKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(masterKeyB64);
  if (raw.length !== 32) throw new Error('MASTER_KEY는 32바이트 base64여야 해요');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM 암호화 → { enc(base64), iv(base64) }. */
export async function aesEncrypt(masterKeyB64: string, plaintext: string): Promise<{ enc: string; iv: string }> {
  const key = await importAesKey(masterKeyB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext));
  return { enc: toBase64(new Uint8Array(ct)), iv: toBase64(iv) };
}

export async function aesDecrypt(masterKeyB64: string, encB64: string, ivB64: string): Promise<string> {
  const key = await importAesKey(masterKeyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(encB64));
  return td.decode(pt);
}

/** 길이가 달라도 상수 시간에 가깝게 비교. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = te.encode(a);
  const bb = te.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** 세션 토큰 등 DB 보관용 단방향 해시 (hex). DB 가 새어도 토큰 원문은 복원 불가 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 현재 키로 먼저, 실패하면 이전 키(교체 중)로 복호화. 어느 키로 풀렸는지 함께 돌려준다 */
export async function aesDecryptAny(env: { MASTER_KEY: string; MASTER_KEY_PREV?: string }, encB64: string, ivB64: string): Promise<{ plaintext: string; usedPrev: boolean }> {
  try { return { plaintext: await aesDecrypt(env.MASTER_KEY, encB64, ivB64), usedPrev: false }; }
  catch (e) {
    if (!env.MASTER_KEY_PREV) throw e;
    return { plaintext: await aesDecrypt(env.MASTER_KEY_PREV, encB64, ivB64), usedPrev: true };
  }
}
