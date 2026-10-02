// /api/kyc — 신분증 사진 제출(암호화 저장) / /api/admin/kyc — 관리자 승인·거절
import { Hono } from 'hono';
import type { KycStatus } from '@easy-futures/shared';
import { authMiddleware, type AppEnv } from '../auth.js';
import { aesEncrypt } from '../crypto.js';
import { getKycDoc, listKyc, saveKycDoc, setKycStatus, findUserById, findUserByLogin, setPassword, reencryptAll, TEMP_PW_TTL_MS } from '../db.js';
import { pbkdf2Hash, randomSalt, aesDecryptAny } from '../crypto.js';
import { badRequest, HttpError } from '../errors.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import { isAdmin } from './auth.js';
import { parseUserIdParam } from '../validate.js';
import { disableAuto } from '../auto/db.js';
import { stopFollowsOfUser } from '../copy/db.js';

const DOC_TYPES = new Set(['id_card', 'driver_license', 'passport']);
const MAX_B64 = 1_400_000; // 약 1MB 이미지 (웹에서 1000px 이하로 줄여서 보냄)

export const kycRoutes = new Hono<AppEnv>();
kycRoutes.use('*', authMiddleware);

kycRoutes.post('/', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.user.kycStatus === 'approved') return c.json({ ok: true, status: 'approved' as KycStatus });
  // 재제출 쿨다운 60초 (대용량 사진 반복 제출 방지)
  const prev = await findUserById(c.env.DB, ctx.user.id);
  if (prev?.kyc_submitted_at && Date.now() - prev.kyc_submitted_at < 60_000) throw new HttpError(429, '방금 제출했어요. 1분 뒤에 다시 시도해 주세요', 'TOO_SOON');
  const b = await readJson(c);
  const docType = typeof b.docType === 'string' ? b.docType : '';
  if (!DOC_TYPES.has(docType)) throw badRequest('신분증 종류를 골라 주세요', 'BAD_DOC_TYPE');
  const image = typeof b.image === 'string' ? b.image : '';
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!m) throw badRequest('사진 파일이 올바르지 않아요. 다시 찍어 주세요', 'BAD_IMAGE');
  if (m[2].length > MAX_B64) throw badRequest('사진이 너무 커요. 다시 찍어 주세요', 'IMAGE_TOO_BIG');
  const { enc, iv } = await aesEncrypt(c.env.MASTER_KEY, m[2]);
  await saveKycDoc(c.env.DB, ctx.user.id, docType, m[1], enc, iv);
  log.info('kyc submitted', { userId: ctx.user.id, docType });
  return c.json({ ok: true, status: 'pending' as KycStatus });
});

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', authMiddleware, async (c, next) => {
  if (!isAdmin(c.env, c.get('ctx').user.loginId)) throw new HttpError(403, '관리자만 볼 수 있어요', 'FORBIDDEN');
  await next();
});

adminRoutes.get('/kyc', async (c) => {
  const status = (c.req.query('status') ?? 'pending') as KycStatus;
  const rows = await listKyc(c.env.DB, status);
  return c.json({ items: rows.map((r) => ({ userId: r.id, loginId: r.login_id, uid: r.uid, submittedAt: r.kyc_submitted_at, docType: r.doc_type, status: r.kyc_status })) });
});

adminRoutes.get('/kyc/:userId/image', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const doc = await getKycDoc(c.env.DB, userId);
  if (!doc) throw new HttpError(404, '사진이 없어요', 'NO_DOC');
  log.info('kyc image viewed', { userId, by: c.get('ctx').user.loginId });
  let b64: string;
  try { b64 = (await aesDecryptAny(c.env, doc.enc, doc.iv)).plaintext; }
  catch { throw new HttpError(409, '사진을 열 수 없어요. 다시 제출을 요청해 주세요', 'DECRYPT_FAILED'); }
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': doc.mime, 'cache-control': 'private, no-store' } });
});

adminRoutes.post('/kyc/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  const action = b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : null;
  if (!action) throw badRequest('approve 또는 reject', 'BAD_ACTION');
  const user = await findUserById(c.env.DB, userId);
  if (!user || user.deleted_at) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : null;
  await setKycStatus(c.env.DB, userId, action, action === 'rejected' ? (note || '신분증을 확인할 수 없어요. 다시 찍어 주세요') : null, c.get('ctx').user.loginId);
  if (action === 'rejected') {
    await disableAuto(c.env.DB, userId, '신분증 확인이 거절돼 AI 자동매매를 껐어요. 신분증을 다시 확인받은 뒤 켜 주세요'); // 감사 H5
    await stopFollowsOfUser(c.env.DB, userId, 'kyc_rejected'); // 카피 팔로우도 같은 자리에서 정지
  }
  log.info('kyc decided', { userId, action, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, status: action });
});

/** 관리자: 비밀번호 초기화 → 임시 비밀번호(숫자 8자리) 발급. 사용자는 로그인 직후 새 비밀번호를 정해야 한다. 24시간 지나면 로그인 불가(setPassword 가 pw_temp_expires_at 을 적는다, 감사 B9) */
adminRoutes.post('/users/reset-password', async (c) => {
  const b = await readJson(c);
  const loginId = typeof b.loginId === 'string' ? b.loginId.trim() : '';
  const user = loginId ? await findUserByLogin(c.env.DB, loginId) : null;
  if (!user || user.deleted_at) throw new HttpError(404, '그 아이디의 회원이 없어요', 'NO_USER');
  const temp = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000).padStart(8, '0');
  const salt = randomSalt();
  await setPassword(c.env.DB, user.id, await pbkdf2Hash(temp, salt), salt, true);
  log.info('password reset by admin', { userId: user.id, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, loginId: user.login_id, tempPassword: temp, expiresAt: Date.now() + TEMP_PW_TTL_MS });
});

/** 관리자: 마스터 키 교체 후 일괄 재암호화 (MASTER_KEY_PREV 가 설정되어 있을 때) */
adminRoutes.post('/rotate-keys', async (c) => {
  if (!c.env.MASTER_KEY_PREV) throw badRequest('MASTER_KEY_PREV 가 설정되어 있지 않아요', 'NO_PREV_KEY');
  const r = await reencryptAll(c.env);
  log.info('keys re-encrypted', { ...r, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, ...r });
});
