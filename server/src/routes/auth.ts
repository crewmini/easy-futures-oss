// /api/auth/* — 가입·로그인·로그아웃·내 정보
import { Hono } from 'hono';
import type { KycStatus, Me } from '@easy-futures/shared';
import { TERMS_VERSION } from '@easy-futures/shared';
import { authMiddleware, clearSessionCookie, readSessionToken, setSessionCookie, type AppEnv } from '../auth.js';
import { pbkdf2Hash, randomSalt, randomToken, timingSafeEqual } from '../crypto.js';
import { clearLoginFails, createSession, createUser, deleteSession, findUserByLogin, getAttempts, getSettings, invalidateCreds, LOCK_FAILS, recordLoginFail, getApiKeyRow, getPartnerByCode, getPartnerByUser, getPartnerApplication, setPassword, agreeTerms, deleteAccount, findUserById, loginIpAllowed, recordLoginIpFail } from '../db.js';
import { HttpError, badRequest } from '../errors.js';
import { readJson } from '../http.js';
import { validateLoginId, validatePassword, validateUid } from '../validate.js';
import { getAutoStatus } from '../auto/db.js';
import { defaultMode, paperEnabled } from '../env.js';
import { cleanupUserCopy } from '../copy/db.js';

export function isAdmin(env: { ADMIN_LOGIN_IDS?: string }, loginId: string): boolean {
  return (env.ADMIN_LOGIN_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(loginId);
}
/** 연습(paper) 모드 허용 여부: 관리자이거나 ALLOW_PAPER=on(테스트·개발). 일반 사용자는 실거래만 (2026-09-18) */
export function paperAllowed(env: { ADMIN_LOGIN_IDS?: string; ALLOW_PAPER?: string }, loginId: string): boolean {
  return paperEnabled(env) || isAdmin(env, loginId);
}
/** 초대 코드는 쉼표로 여러 개 등록 가능 */
const SIGNUP_PER_HOUR = 20;
async function allowSignup(db: D1Database, ip: string): Promise<boolean> {
  const now = Date.now();
  const row = await db.prepare('SELECT count, window_start FROM signup_attempts WHERE ip = ?').bind(ip).first<{ count: number; window_start: number }>();
  if (!row || now - row.window_start > 3_600_000) { await db.prepare('INSERT INTO signup_attempts (ip, count, window_start) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = excluded.window_start').bind(ip, now).run(); return true; }
  if (row.count >= SIGNUP_PER_HOUR) return false;
  await db.prepare('UPDATE signup_attempts SET count = count + 1 WHERE ip = ?').bind(ip).run();
  return true;
}
function inviteOk(env: { INVITE_CODE: string }, given: string): boolean {
  const codes = (env.INVITE_CODE ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return codes.some((code) => code.length === given.length && timingSafeEqual(given, code));
}

const LOCKED_MSG = `${LOCK_FAILS}번 틀려서 10분 동안 잠겼어요`;
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 없는 아이디용 더미 솔트(16바이트 base64)

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/signup', async (c) => {
  const b = await readJson(c);
  const loginId = validateLoginId(b.loginId);
  const password = validatePassword(b.password);
  const uid = validateUid(b.uid);
  // 가입 코드는 선택(2026-09-08 결정). 넣었는데 틀리면 오타일 수 있어 알려 주고, 비우면 그냥 가입. 대신 IP 당 시간당 가입 수를 제한한다.
  const invite = typeof b.inviteCode === 'string' ? b.inviteCode.trim() : '';
  if (invite && !inviteOk(c.env, invite)) throw badRequest('가입 코드가 맞지 않아요. 코드가 없으면 비워 두세요', 'BAD_INVITE');
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (!(await allowSignup(c.env.DB, ip))) throw new HttpError(429, '이 인터넷에서 가입이 너무 많아요. 한 시간 뒤에 다시 해 주세요', 'SIGNUP_RATE');
  if (b.termsAgreed !== true) throw badRequest('이용약관에 동의해야 가입할 수 있어요', 'TERMS_REQUIRED');
  const termsVersion = typeof b.termsVersion === 'string' ? b.termsVersion.slice(0, 20) : null;
  if (termsVersion !== TERMS_VERSION) throw badRequest('최신 이용약관에 동의해야 가입할 수 있어요. 화면을 새로고침해 주세요', 'TERMS_VERSION');
  // 관리자 목록에 있는 아이디는 가입 자체를 막는다 (아이디 선점으로 관리자 권한 획득 방지)
  if (isAdmin(c.env, loginId)) throw new HttpError(409, '사용할 수 없는 아이디예요', 'RESERVED');
  if (await findUserByLogin(c.env.DB, loginId)) throw new HttpError(409, '이미 있는 아이디예요', 'DUPLICATE');
  // 제휴 코드(선택): 있으면 반드시 유효해야 한다
  const affiliate = typeof b.affiliateCode === 'string' ? b.affiliateCode.trim().toUpperCase() : '';
  const partner = affiliate ? await getPartnerByCode(c.env.DB, affiliate) : null;
  if (affiliate && !partner) throw badRequest('제휴 코드가 맞지 않아요. 비워 두거나 다시 확인해 주세요', 'BAD_AFFILIATE');

  const salt = randomSalt();
  const hash = await pbkdf2Hash(password, salt);
  let user;
  try {
    user = await createUser(c.env, loginId, hash, salt, uid, Date.now(), termsVersion, partner?.user_id ?? null);
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes('UNIQUE') && msg.includes('uid')) throw new HttpError(409, '이미 가입된 UID예요. 로그인해 주세요', 'DUPLICATE_UID');
    if (msg.includes('UNIQUE') && msg.includes('login_id')) throw new HttpError(409, '이미 있는 아이디예요', 'DUPLICATE');   // 위 조회와 INSERT 사이에 같은 아이디가 먼저 들어온 경합 (감사 B22)
    throw e;
  }
  const token = randomToken();
  await createSession(c.env.DB, token, user.id);
  setSessionCookie(c, token);
  const me: Me = { loginId, hasApiKey: false, apiKeyPreview: null, mode: defaultMode(c.env), uid, kycStatus: 'none', kycNote: null, isAdmin: isAdmin(c.env, loginId), affiliateCode: null, partnerStatus: 'none', mustChangePassword: false, termsOutdated: false, autoStatus: 'none' };
  return c.json(me);
});

authRoutes.post('/login', async (c) => {
  const b = await readJson(c);
  const loginId = typeof b.loginId === 'string' ? b.loginId.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!loginId || !password) throw badRequest('아이디와 비밀번호를 넣어 주세요', 'BAD_LOGIN');
  // 형식이 안 맞는 아이디는 DB 를 건드리지 않고 거절 (login_attempts 오염 방지)
  if (!/^[A-Za-z0-9]{3,20}$/.test(loginId) || password.length > 200) throw new HttpError(401, '아이디 또는 비밀번호가 틀렸어요', 'BAD_CREDENTIALS');

  // 잠금 키 = 아이디 + 요청 IP. 남의 아이디로 잠금을 걸어 본인을 못 들어오게 하는 공격 방지
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  // IP 단위 실패 제한(10분 30회)을 해시 계산보다 먼저 — 아이디를 바꿔 가며 뿌리는 CPU 소모 공격 차단 (감사 B8)
  if (!(await loginIpAllowed(c.env.DB, ip))) throw new HttpError(429, '시도가 너무 많아요. 10분 뒤 다시 해 주세요', 'TOO_MANY_ATTEMPTS');
  const lockKey = `${loginId}@${ip}`;
  const attempts = await getAttempts(c.env.DB, lockKey);
  if (attempts?.locked_until && attempts.locked_until > Date.now()) throw new HttpError(423, LOCKED_MSG, 'LOCKED');

  const found = await findUserByLogin(c.env.DB, loginId);
  const user = found && !found.deleted_at ? found : null;
  // 없는 아이디도 같은 시간이 걸리게 (아이디 존재 여부가 응답 시간으로 새지 않도록)
  const ok = user ? timingSafeEqual(await pbkdf2Hash(password, user.pw_salt), user.pw_hash) : (await pbkdf2Hash(password, DUMMY_SALT), false);
  if (!user || !ok) {
    await recordLoginIpFail(c.env.DB, ip);
    const r = await recordLoginFail(c.env.DB, lockKey);
    if (r.lockedUntil) throw new HttpError(423, LOCKED_MSG, 'LOCKED');
    throw new HttpError(401, '아이디 또는 비밀번호가 틀렸어요', 'BAD_CREDENTIALS');
  }
  // 관리자가 준 임시 비밀번호는 24시간 안에만 (감사 B9). 맞는 비밀번호를 확인한 뒤에 보므로 만료 여부로 아이디 존재가 새지 않는다
  if (user.must_change_pw && user.pw_temp_expires_at != null && user.pw_temp_expires_at < Date.now()) throw new HttpError(403, '임시 비밀번호 기한(24시간)이 지났어요. 담당자에게 다시 요청해 주세요', 'TEMP_PW_EXPIRED');
  if (attempts) await clearLoginFails(c.env.DB, lockKey); // 실패 기록이 있을 때만 D1 쓰기
  invalidateCreds(user.id);
  const token = randomToken();
  await createSession(c.env.DB, token, user.id);
  setSessionCookie(c, token);
  const [settings, key, partner, app] = await Promise.all([getSettings(c.env, user.id), getApiKeyRow(c.env.DB, user.id), getPartnerByUser(c.env.DB, user.id), getPartnerApplication(c.env.DB, user.id)]);
  const me: Me = { loginId: user.login_id, hasApiKey: !!key, apiKeyPreview: key?.preview ?? null, mode: settings.mode, uid: user.uid ?? null, kycStatus: (user.kyc_status ?? 'none') as KycStatus, kycNote: user.kyc_note ?? null, isAdmin: isAdmin(c.env, user.login_id), affiliateCode: partner?.code ?? null, partnerStatus: partner ? 'approved' : (app?.status ?? 'none'), mustChangePassword: !!user.must_change_pw, termsOutdated: (user.terms_version ?? null) !== TERMS_VERSION, autoStatus: ((user as { auto_status?: string }).auto_status ?? 'none') as Me['autoStatus'] };
  return c.json(me);
});

authRoutes.post('/logout', async (c) => {
  const token = readSessionToken(c);
  if (token) await deleteSession(c.env.DB, token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', authMiddleware, async (c) => {
  const ctx = c.get('ctx');
  const [partner, app] = await Promise.all([getPartnerByUser(c.env.DB, ctx.user.id), getPartnerApplication(c.env.DB, ctx.user.id)]);
  const me: Me = { loginId: ctx.user.loginId, hasApiKey: !!ctx.creds, apiKeyPreview: ctx.apiKeyPreview, mode: ctx.settings.mode, uid: ctx.user.uid, kycStatus: ctx.user.kycStatus, kycNote: ctx.user.kycNote, isAdmin: isAdmin(c.env, ctx.user.loginId), affiliateCode: partner?.code ?? null, partnerStatus: partner ? 'approved' : (app?.status ?? 'none'), mustChangePassword: ctx.user.mustChangePw, termsOutdated: ctx.user.termsVersion !== TERMS_VERSION, autoStatus: await getAutoStatus(c.env.DB, ctx.user.id) };
  return c.json(me);
});

/** 비밀번호 변경 (임시 비밀번호 후 필수 변경 포함) */
authRoutes.post('/change-password', authMiddleware, async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  const current = typeof b.currentPassword === 'string' ? b.currentPassword : '';
  const next = validatePassword(b.newPassword);
  const user = await findUserById(c.env.DB, ctx.user.id);
  if (!user) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  if (!timingSafeEqual(await pbkdf2Hash(current, user.pw_salt), user.pw_hash)) throw new HttpError(401, '지금 비밀번호가 틀렸어요', 'BAD_CREDENTIALS');
  if (current === next) throw badRequest('새 비밀번호는 지금 것과 달라야 해요', 'SAME_PASSWORD');
  const salt = randomSalt();
  await setPassword(c.env.DB, ctx.user.id, await pbkdf2Hash(next, salt), salt, false);
  // 세션이 모두 끊기므로 새 세션 발급
  const token = randomToken();
  await createSession(c.env.DB, token, ctx.user.id);
  setSessionCookie(c, token);
  return c.json({ ok: true });
});

/** 약관 재동의 */
authRoutes.post('/agree-terms', authMiddleware, async (c) => {
  const b = await readJson(c);
  if (b.version !== TERMS_VERSION) throw badRequest('최신 약관에 동의해 주세요', 'TERMS_VERSION');
  await agreeTerms(c.env.DB, c.get('ctx').user.id, TERMS_VERSION);
  return c.json({ ok: true, version: TERMS_VERSION });
});

/** 회원 탈퇴: 비밀번호 확인. 실거래 포지션·키는 먼저 정리하도록 안내 */
authRoutes.post('/delete-account', authMiddleware, async (c) => {
  const ctx = c.get('ctx');
  const b = await readJson(c);
  const password = typeof b.password === 'string' ? b.password : '';
  const user = await findUserById(c.env.DB, ctx.user.id);
  if (!user) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  if (!timingSafeEqual(await pbkdf2Hash(password, user.pw_salt), user.pw_hash)) throw new HttpError(401, '비밀번호가 틀렸어요', 'BAD_CREDENTIALS');
  if (isAdmin(c.env, ctx.user.loginId)) throw badRequest('관리자 계정은 탈퇴할 수 없어요', 'ADMIN');
  await cleanupUserCopy(c.env.DB, ctx.user.id); // 카피: 팔로우 정지·장부 삭제·마스터 행 삭제 (탈퇴 전에)
  await deleteAccount(c.env.DB, ctx.user.id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
