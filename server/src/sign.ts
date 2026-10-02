// WOO X Pro 서명: sign = hex( HMAC_SHA256( secret, `${timestamp}#${memo}#${body}` ) )  — WebCrypto(async)
import { toHex } from './crypto.js';

const te = new TextEncoder();

export function signString(timestampMs: number | string, memo: string, body: string): string {
  return `${timestampMs}#${memo}#${body}`;
}

export async function sign(secret: string, timestampMs: number | string, memo: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, te.encode(signString(timestampMs, memo, body)));
  return toHex(new Uint8Array(mac));
}

export interface SignedHeaders {
  'X-API-KEY': string;
  'X-API-SIGN': string;
  'X-API-TIMESTAMP': string;
  [k: string]: string;
}

/**
 * 프라이빗 요청 헤더. body는 실제 전송 바이트와 동일해야 한다
 * (POST: JSON 문자열 그대로, GET: 쿼리스트링 그대로, 없으면 빈 문자열).
 */
export async function buildHeaders(
  apiKey: string,
  secret: string,
  memo: string,
  body: string,
  timestampMs: number = Date.now(),
): Promise<SignedHeaders> {
  return {
    'X-API-KEY': apiKey,
    'X-API-SIGN': await sign(secret, timestampMs, memo, body),
    'X-API-TIMESTAMP': String(timestampMs),
  };
}

/** WS 프라이빗 로그인용 서명 문자열은 `${ts}#${memo}#wooxpro.WebSocket`. */
export function signWebSocketLogin(secret: string, timestampMs: number, memo: string): Promise<string> {
  return sign(secret, timestampMs, memo, 'wooxpro.WebSocket');
}
