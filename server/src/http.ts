// 요청 본문 파싱 등 HTTP 공용 헬퍼.
import type { Context } from 'hono';
import { badRequest } from './errors.js';

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw badRequest('요청 형식이 올바르지 않아요 (JSON)', 'BAD_JSON');
  }
}
