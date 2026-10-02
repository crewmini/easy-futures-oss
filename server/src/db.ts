// D1 접근 헬퍼. 모든 SQL은 여기서만. 비밀값(복호화된 키)은 로그에 절대 남기지 않는다.
import type { Settings } from '@easy-futures/shared';
import type { Env } from './env.js';
import { sha256Hex, aesDecrypt, aesDecryptAny, aesEncrypt } from './crypto.js';
import { defaultMode, numVar as numVarSafe } from './env.js';
import type { WooxCredentials } from './woox/client.js';
import { log } from './log.js';

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';
export interface UserRow {
  id: number;
  login_id: string;
  pw_hash: string;
  pw_salt: string;
  created_at: number;
  uid?: string | null;
  terms_agreed_at?: number | null;
  kyc_status?: KycStatus | null;
  kyc_submitted_at?: number | null;
  kyc_note?: string | null;
  partner_id?: number | null;
  terms_version?: string | null;
  must_change_pw?: number | null;
  pw_temp_expires_at?: number | null;   // 관리자 임시 비밀번호 만료 시각 (D1 0022). must_change_pw=1 일 때만 의미
  deleted_at?: number | null;
}

interface SettingsRow {
  user_id: number;
  mode: string;
  max_leverage: number;
  max_amount_usdt: number;
  usdt_krw: number;
}

interface ApiKeyRow {
  user_id: number;
  enc: string;
  iv: string;
  preview: string;
  updated_at: number | null;
}

interface SessionRow {
  token: string;
  user_id: number;
  expires_at: number;
}

interface AttemptRow {
  login_id: string;
  fails: number;
  locked_until: number | null;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---- users ----
export async function findUserByLogin(db: D1Database, loginId: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE login_id = ?').bind(loginId).first<UserRow>();
}

export async function findUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function createUser(env: Env, loginId: string, pwHash: string, pwSalt: string, uid: string, termsAgreedAt: number, termsVersion: string | null = null, partnerId: number | null = null): Promise<UserRow> {
  const now = Date.now();
  const r = await env.DB.prepare('INSERT INTO users (login_id, pw_hash, pw_salt, created_at, uid, terms_agreed_at, kyc_status, terms_version, partner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(loginId, pwHash, pwSalt, now, uid, termsAgreedAt, 'none', termsVersion, partnerId)
    .run();
  const id = Number(r.meta.last_row_id);
  await env.DB.prepare('INSERT INTO settings (user_id, mode, max_leverage, max_amount_usdt, usdt_krw) VALUES (?, ?, ?, ?, ?)')
    .bind(id, defaultMode(env), 100, 100000, numVarSafe(env.USDT_KRW_DEFAULT, 1380))
    .run();
  return { id, login_id: loginId, pw_hash: pwHash, pw_salt: pwSalt, created_at: now, uid, terms_agreed_at: termsAgreedAt, kyc_status: 'none' };
}

// ---- 신분증 인증 (KYC) ----
export interface KycDocRow { user_id: number; doc_type: string; mime: string; enc: string; iv: string; created_at: number }
export interface KycPendingRow { id: number; login_id: string; uid: string | null; kyc_submitted_at: number | null; doc_type: string | null; kyc_status: KycStatus }

export async function saveKycDoc(db: D1Database, userId: number, docType: string, mime: string, enc: string, iv: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO kyc_docs (user_id, doc_type, mime, enc, iv, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET doc_type = excluded.doc_type, mime = excluded.mime, enc = excluded.enc, iv = excluded.iv, created_at = excluded.created_at').bind(userId, docType, mime, enc, iv, now),
    db.prepare("UPDATE users SET kyc_status = 'pending', kyc_submitted_at = ?, kyc_note = NULL WHERE id = ?").bind(now, userId),
  ]);
  invalidateUser(userId);
}
export async function getKycDoc(db: D1Database, userId: number): Promise<KycDocRow | null> {
  return db.prepare('SELECT * FROM kyc_docs WHERE user_id = ?').bind(userId).first<KycDocRow>();
}
export async function setKycStatus(db: D1Database, userId: number, status: KycStatus, note: string | null, by: string): Promise<void> {
  const stmts = [db.prepare('UPDATE users SET kyc_status = ?, kyc_note = ?, kyc_decided_at = ?, kyc_decided_by = ? WHERE id = ?').bind(status, note, Date.now(), by, userId)];
  // 승인·거절 모두 "확인 완료" → 사진은 즉시 삭제 (약관 제9조). 거절 시 재제출하면 새로 받는다.
  if (status === 'approved' || status === 'rejected') stmts.push(db.prepare('DELETE FROM kyc_docs WHERE user_id = ?').bind(userId));
  await db.batch(stmts);
  invalidateUser(userId);
}
export async function listKyc(db: D1Database, status: KycStatus): Promise<KycPendingRow[]> {
  const r = await db.prepare('SELECT u.id, u.login_id, u.uid, u.kyc_submitted_at, u.kyc_status, d.doc_type FROM users u LEFT JOIN kyc_docs d ON d.user_id = u.id WHERE u.kyc_status = ? ORDER BY u.kyc_submitted_at ASC').bind(status).all<KycPendingRow>();
  return r.results ?? [];
}

// ---- settings ----
function rowToSettings(r: SettingsRow | null, env: Env): Settings {
  return {
    mode: r?.mode === 'live' ? 'live' : r?.mode === 'paper' ? 'paper' : defaultMode(env),
    maxLeverage: r?.max_leverage ?? 100,
    maxAmountUsdt: r?.max_amount_usdt ?? 100000,
    usdtKrw: r?.usdt_krw ?? numVarSafe(env.USDT_KRW_DEFAULT, 1380),
  };
}

export async function getSettings(env: Env, userId: number): Promise<Settings> {
  const r = await env.DB.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first<SettingsRow>();
  return rowToSettings(r, env);
}

export async function saveSettings(env: Env, userId: number, s: Settings): Promise<Settings> {
  invalidateUser(userId);
  await env.DB.prepare(
    `INSERT INTO settings (user_id, mode, max_leverage, max_amount_usdt, usdt_krw) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, max_leverage = excluded.max_leverage,
       max_amount_usdt = excluded.max_amount_usdt, usdt_krw = excluded.usdt_krw`,
  )
    .bind(userId, s.mode, s.maxLeverage, s.maxAmountUsdt, s.usdtKrw)
    .run();
  return s;
}

// ---- api keys ----
export async function getApiKeyRow(db: D1Database, userId: number): Promise<ApiKeyRow | null> {
  return db.prepare('SELECT * FROM api_keys WHERE user_id = ?').bind(userId).first<ApiKeyRow>();
}

export async function saveApiKey(db: D1Database, userId: number, enc: string, iv: string, preview: string): Promise<void> {
  invalidateUser(userId);
  await db
    .prepare(
      `INSERT INTO api_keys (user_id, enc, iv, preview, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enc = excluded.enc, iv = excluded.iv, preview = excluded.preview, updated_at = excluded.updated_at`,
    )
    .bind(userId, enc, iv, preview, Date.now())
    .run();
  credsCache.delete(userId);
}

export async function deleteApiKey(db: D1Database, userId: number): Promise<void> {
  invalidateUser(userId);
  await db.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId).run();
  credsCache.delete(userId);
}

// ---- sessions ----
// 세션 토큰은 해시로만 저장한다 (DB 유출 시 세션 탈취 방지). 쿠키에는 원문이 간다.
export async function createSession(db: D1Database, token: string, userId: number): Promise<number> {
  const expires = Date.now() + SESSION_TTL_MS;
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(token), userId, expires),
    // 만료된 세션 정리 (사용자 본인 것 + 오래된 것 일부): 테이블이 무한히 자라지 않게
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now),
    db.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT 50)').bind(now),
  ]);
  return expires;
}

export async function getSession(db: D1Database, token: string): Promise<SessionRow | null> {
  const r = await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(await sha256Hex(token)).first<SessionRow>();
  if (!r) return null;
  if (r.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(r.token).run();
    return null;
  }
  return r;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  invalidateToken(token);
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256Hex(token)).run();
}

// ---- login attempts ----
export const LOCK_FAILS = 5;
export const LOCK_MS = 10 * 60 * 1000;

export async function getAttempts(db: D1Database, loginId: string): Promise<AttemptRow | null> {
  return db.prepare('SELECT * FROM login_attempts WHERE login_id = ?').bind(loginId).first<AttemptRow>();
}

/** 실패 1회 기록. 5회째면 10분 잠금. 반환: 잠겼는지. */
export async function recordLoginFail(db: D1Database, loginId: string): Promise<{ fails: number; lockedUntil: number | null }> {
  const cur = await getAttempts(db, loginId);
  // 잠금 시간이 지났으면 처음부터 다시 센다 (영구 잠금 방지)
  const expired = !!cur?.locked_until && cur.locked_until <= Date.now();
  const fails = (expired ? 0 : (cur?.fails ?? 0)) + 1;
  const lockedUntil = fails >= LOCK_FAILS ? Date.now() + LOCK_MS : null;
  await db
    .prepare(
      `INSERT INTO login_attempts (login_id, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(login_id) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
    )
    .bind(loginId, fails, lockedUntil, Date.now())
    .run();
  return { fails, lockedUntil };
}

export async function clearLoginFails(db: D1Database, loginId: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE login_id = ?').bind(loginId).run();
}

// ---- IP 당 로그인 실패 제한 (감사 B8): 한 IP 가 아이디를 바꿔 가며 뿌리면 시도마다 PBKDF2 → CPU 소모. 10분 창에 실패 30회 넘으면 거절 ----
export const LOGIN_IP_MAX_FAILS = 30;
export const LOGIN_IP_WINDOW_MS = 10 * 60 * 1000;
/** 이 IP 가 아직 시도해도 되는지 (해시 계산 전에 본다). 성공한 로그인은 세지 않아 공용 IP(통신사 NAT) 사용자가 억울하게 막히지 않는다 */
export async function loginIpAllowed(db: D1Database, ip: string, now = Date.now()): Promise<boolean> {
  const row = await db.prepare('SELECT count, window_start FROM login_ip_attempts WHERE ip = ?').bind(ip).first<{ count: number; window_start: number }>();
  return !row || now - row.window_start > LOGIN_IP_WINDOW_MS || row.count < LOGIN_IP_MAX_FAILS;
}
export async function recordLoginIpFail(db: D1Database, ip: string, now = Date.now()): Promise<void> {
  // 창이 지났으면 1부터 다시, 아니면 +1 (signup_attempts 와 같은 모양)
  await db.prepare(
    `INSERT INTO login_ip_attempts (ip, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN ? - window_start > ? THEN excluded.window_start ELSE window_start END`,
  ).bind(ip, now, now, LOGIN_IP_WINDOW_MS, now, LOGIN_IP_WINDOW_MS).run();
}

// ---- user context (세션 → 사용자·설정·복호화된 키) ----
export interface UserContext {
  user: { id: number; loginId: string; uid: string | null; kycStatus: KycStatus; kycNote: string | null; mustChangePw: boolean; termsVersion: string | null };
  settings: Settings;
  creds: WooxCredentials | null;
  apiKeyPreview: string | null;
  /** 키 행은 있는데 복호화에 실패(MASTER_KEY 교체·누락·손상). creds 는 null 이지만 "키 없음"이 아니다 → 거래 경로는 503 KEY_DECRYPT_FAILED (감사 B5) */
  credsDecryptFailed?: boolean;
  sessionToken: string;
  env?: Env;   // 거래소 요청 관문(RateGate) 등 바인딩 접근용 — 요청마다의 환경 (DO 스텁은 만든 컨텍스트에서만 유효)
}

interface CredsCacheEntry {
  creds: WooxCredentials | null;
  preview: string | null;
  decryptFailed: boolean;
  expiresAt: number;
}

/** 격리환경(isolate) 단위 캐시. 3초 폴링마다 D1 + 복호화를 반복하지 않기 위해 60초 TTL. */
const credsCache = new Map<number, CredsCacheEntry>();
const CREDS_TTL_MS = 60_000;

export function invalidateCreds(userId: number): void {
  credsCache.delete(userId);
}

/** 다른 사용자의 거래소 키(복호화). 제휴사 페이지가 고객 포지션을 읽을 때 사용. */
export async function getCredsForUser(env: Env, userId: number): Promise<WooxCredentials | null> {
  return (await loadCreds(env, userId)).creds;
}

/** 키 상태까지: creds 가 null 이어도 decryptFailed 면 키가 "있는데 못 읽는" 상태 (호출자가 "키 없음"과 구분해야 할 때) */
export async function getCredsStatus(env: Env, userId: number): Promise<{ creds: WooxCredentials | null; decryptFailed: boolean }> {
  const e = await loadCreds(env, userId);
  return { creds: e.creds, decryptFailed: e.decryptFailed };
}

async function loadCreds(env: Env, userId: number): Promise<CredsCacheEntry> {
  const now = Date.now();
  const hit = credsCache.get(userId);
  if (hit && hit.expiresAt > now) return hit;
  const row = await getApiKeyRow(env.DB, userId);
  let entry: CredsCacheEntry = { creds: null, preview: null, decryptFailed: false, expiresAt: now + CREDS_TTL_MS };
  if (row) {
    try {
      const { plaintext, usedPrev } = await aesDecryptAny(env, row.enc, row.iv);
      const json = JSON.parse(plaintext) as WooxCredentials;
      if (usedPrev) {
        // 이전 키로 풀린 자료는 현재 키로 다시 암호화해 둔다 (키 교체의 지연 마이그레이션)
        const re = await aesEncrypt(env.MASTER_KEY, plaintext);
        await env.DB.prepare('UPDATE api_keys SET enc = ?, iv = ?, key_ver = key_ver + 1 WHERE user_id = ?').bind(re.enc, re.iv, userId).run();
      }
      entry = { creds: json, preview: row.preview, decryptFailed: false, expiresAt: now + CREDS_TTL_MS };
    } catch (e) {
      // MASTER_KEY가 바뀌었거나 데이터 손상 (비밀값 로그 금지). "키 없음"과 구분해 decryptFailed 로 표시 — 사용자가 새 키를 등록(덮어쓰기)하는 건 막지 않는다
      log.error('api key decrypt failed', { userId, message: (e as Error).message });
      entry = { creds: null, preview: row.preview, decryptFailed: true, expiresAt: now + CREDS_TTL_MS };
    }
  }
  credsCache.set(userId, entry);
  return entry;
}

/**
 * 세션 토큰 → 사용자 컨텍스트 캐시(격리환경 단위, 20초).
 * 3초 폴링마다 D1 왕복 3회(세션·사용자·설정)를 반복하지 않기 위함. 설정/키/로그아웃 변경 시 invalidateUser 로 비운다.
 */
const ctxCache = new Map<string, { ctx: UserContext; expiresAt: number }>();
const CTX_TTL_MS = 20_000;

export function invalidateUser(userId: number): void {
  credsCache.delete(userId);
  for (const [tok, e] of ctxCache) if (e.ctx.user.id === userId) ctxCache.delete(tok);
}
export function invalidateToken(token: string): void {
  ctxCache.delete(token);
}

export async function getUserContext(env: Env, token: string, fresh = false): Promise<UserContext | null> {
  const now = Date.now();
  const hit = fresh ? undefined : ctxCache.get(token);
  if (hit && hit.expiresAt > now) return hit.ctx;
  const sess = await getSession(env.DB, token);
  if (!sess) return null;
  const [user, settings, ck] = await Promise.all([findUserById(env.DB, sess.user_id), getSettings(env, sess.user_id), loadCreds(env, sess.user_id)]);
  if (!user || user.deleted_at) return null;
  const ctx: UserContext = {
    user: { id: user.id, loginId: user.login_id, uid: user.uid ?? null, kycStatus: (user.kyc_status ?? 'none') as KycStatus, kycNote: user.kyc_note ?? null, mustChangePw: !!user.must_change_pw, termsVersion: user.terms_version ?? null },
    settings,
    creds: ck.creds,
    apiKeyPreview: ck.preview,
    ...(ck.decryptFailed ? { credsDecryptFailed: true } : {}),
    sessionToken: token,
    env,
  };
  if (ctxCache.size > 5000) ctxCache.clear();
  ctxCache.set(token, { ctx, expiresAt: now + CTX_TTL_MS });
  return ctx;
}

// ---- 제휴사 ----
export interface PartnerRow { user_id: number; code: string; created_at: number; company?: string | null; name?: string | null; phone?: string | null }
export type PartnerAppStatus = 'pending' | 'approved' | 'rejected' | 'removed';
export interface PartnerAppRow { user_id: number; company: string; name: string; phone: string; status: PartnerAppStatus; note: string | null; submitted_at: number; decided_at: number | null; decided_by: string | null }
export interface PartnerMemberRow { id: number; login_id: string; uid: string | null; kyc_status: KycStatus; created_at: number }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
export function randomPartnerCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 'EF-' + Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
export async function getPartnerByUser(db: D1Database, userId: number): Promise<PartnerRow | null> {
  return db.prepare('SELECT * FROM partners WHERE user_id = ?').bind(userId).first<PartnerRow>();
}
export async function getPartnerByCode(db: D1Database, code: string): Promise<PartnerRow | null> {
  return db.prepare('SELECT * FROM partners WHERE code = ?').bind(code).first<PartnerRow>();
}
export async function createPartner(db: D1Database, userId: number, info?: { company: string; name: string; phone: string }): Promise<PartnerRow> {
  const existing = await getPartnerByUser(db, userId);
  if (existing) return existing;
  for (let i = 0; i < 5; i++) {
    const code = randomPartnerCode();
    try {
      await db.prepare('INSERT INTO partners (user_id, code, created_at, company, name, phone) VALUES (?, ?, ?, ?, ?, ?)').bind(userId, code, Date.now(), info?.company ?? null, info?.name ?? null, info?.phone ?? null).run();
      return { user_id: userId, code, created_at: Date.now(), ...info };
    } catch { /* 코드 충돌 시 재시도 */ }
  }
  throw new Error('partner code collision');
}
/** 제휴사 제거: 코드 삭제, 고객 연결 해제, 신청 기록은 removed 로 남긴다 */
export async function removePartner(db: D1Database, userId: number, by: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE users SET partner_id = NULL WHERE partner_id = ?').bind(userId),
    db.prepare('DELETE FROM partners WHERE user_id = ?').bind(userId),
    db.prepare("UPDATE partner_applications SET status = 'removed', decided_at = ?, decided_by = ? WHERE user_id = ?").bind(Date.now(), by, userId),
  ]);
  invalidateUser(userId);
}

// ---- 제휴사 신청 ----
export async function getPartnerApplication(db: D1Database, userId: number): Promise<PartnerAppRow | null> {
  return db.prepare('SELECT * FROM partner_applications WHERE user_id = ?').bind(userId).first<PartnerAppRow>();
}
export async function savePartnerApplication(db: D1Database, userId: number, a: { company: string; name: string; phone: string }): Promise<void> {
  await db.prepare(`INSERT INTO partner_applications (user_id, company, name, phone, status, note, submitted_at, decided_at, decided_by) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)
    ON CONFLICT(user_id) DO UPDATE SET company = excluded.company, name = excluded.name, phone = excluded.phone, status = 'pending', note = NULL, submitted_at = excluded.submitted_at, decided_at = NULL, decided_by = NULL`)
    .bind(userId, a.company, a.name, a.phone, Date.now()).run();
}
export async function decidePartnerApplication(db: D1Database, userId: number, status: 'approved' | 'rejected', note: string | null, by: string): Promise<void> {
  await db.prepare('UPDATE partner_applications SET status = ?, note = ?, decided_at = ?, decided_by = ? WHERE user_id = ?').bind(status, note, Date.now(), by, userId).run();
}
export async function listPartnerApplications(db: D1Database, status: PartnerAppStatus): Promise<(PartnerAppRow & { login_id: string; uid: string | null })[]> {
  const r = await db.prepare('SELECT a.*, u.login_id, u.uid FROM partner_applications a JOIN users u ON u.id = a.user_id WHERE a.status = ? ORDER BY a.submitted_at ASC').bind(status).all<PartnerAppRow & { login_id: string; uid: string | null }>();
  return r.results ?? [];
}
export async function listPartners(db: D1Database): Promise<(PartnerRow & { login_id: string; members: number })[]> {
  const r = await db.prepare('SELECT p.user_id, p.code, p.created_at, p.company, p.name, p.phone, u.login_id, (SELECT count(*) FROM users m WHERE m.partner_id = p.user_id) AS members FROM partners p JOIN users u ON u.id = p.user_id ORDER BY p.created_at').all<PartnerRow & { login_id: string; members: number }>();
  return r.results ?? [];
}
export async function setUserPartner(db: D1Database, userId: number, partnerId: number | null): Promise<void> {
  await db.prepare('UPDATE users SET partner_id = ? WHERE id = ?').bind(partnerId, userId).run();
  invalidateUser(userId);
}
export async function findUserByUid(db: D1Database, uid: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE uid = ? ORDER BY id LIMIT 1').bind(uid).first<UserRow>();
}
export async function listPartnerMembers(db: D1Database, partnerId: number): Promise<PartnerMemberRow[]> {
  const r = await db.prepare('SELECT id, login_id, uid, kyc_status, created_at, auto_status FROM users WHERE partner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').bind(partnerId).all<PartnerMemberRow>();
  return r.results ?? [];
}

// ---- 계정 생명주기: 비밀번호 초기화/변경, 약관 재동의, 탈퇴 ----
export const TEMP_PW_TTL_MS = 24 * 60 * 60 * 1000;   // 관리자 임시 비밀번호 유효 기간 (감사 B9)
/** mustChange=true(관리자 임시 비밀번호)면 24시간 만료를 함께 적는다. 사용자가 새 비밀번호를 정하면(false) 만료도 지운다 */
export async function setPassword(db: D1Database, userId: number, pwHash: string, pwSalt: string, mustChange: boolean): Promise<void> {
  await db.batch([
    db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change_pw = ?, pw_temp_expires_at = ? WHERE id = ?').bind(pwHash, pwSalt, mustChange ? 1 : 0, mustChange ? Date.now() + TEMP_PW_TTL_MS : null, userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId), // 기존 세션 모두 종료
  ]);
  invalidateUser(userId);
}
export async function agreeTerms(db: D1Database, userId: number, version: string): Promise<void> {
  await db.prepare('UPDATE users SET terms_version = ?, terms_agreed_at = ? WHERE id = ?').bind(version, Date.now(), userId).run();
  invalidateUser(userId);
}
/** 회원 탈퇴: 개인정보·키·사진·세션·설정·제휴 연결 삭제, 계정 행은 익명화해 기록(가입일·처리 이력)만 남긴다 */
export async function deleteAccount(db: D1Database, userId: number): Promise<void> {
  const now = Date.now();
  const loginId = (await db.prepare('SELECT login_id FROM users WHERE id = ?').bind(userId).first<{ login_id: string }>())?.login_id ?? '';
  await db.batch([
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM kyc_docs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM partners WHERE user_id = ?').bind(userId),
    db.prepare('UPDATE users SET partner_id = NULL WHERE partner_id = ?').bind(userId),
    db.prepare("UPDATE partner_applications SET status = CASE WHEN status IN ('pending','approved') THEN 'removed' ELSE status END, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, 'self-delete'), name = '', phone = '', company = '' WHERE user_id = ?").bind(now, userId),
    db.prepare('DELETE FROM auto_settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM login_attempts WHERE login_id = ? OR login_id LIKE ?').bind(loginId, `${loginId}@%`),
    db.prepare("UPDATE users SET login_id = 'deleted_' || id, pw_hash = 'x', pw_salt = 'x', uid = NULL, kyc_status = 'none', kyc_note = NULL, partner_id = NULL, auto_status = 'none', deleted_at = ? WHERE id = ?").bind(now, userId),
  ]);
  invalidateUser(userId);
}
/** 키 교체: 이전 키로 암호화된 모든 행을 현재 키로 다시 암호화. 반환: 처리한 행 수 */
export async function reencryptAll(env: Env): Promise<{ apiKeys: number; kycDocs: number }> {
  if (!env.MASTER_KEY_PREV) return { apiKeys: 0, kycDocs: 0 };
  let apiKeys = 0, kycDocs = 0;
  const keys = (await env.DB.prepare('SELECT user_id, enc, iv FROM api_keys').all<{ user_id: number; enc: string; iv: string }>()).results ?? [];
  for (const r of keys) {
    const d = await aesDecryptAny(env, r.enc, r.iv).catch(() => null);
    if (!d || !d.usedPrev) continue;
    const re = await aesEncrypt(env.MASTER_KEY, d.plaintext);
    await env.DB.prepare('UPDATE api_keys SET enc = ?, iv = ?, key_ver = key_ver + 1 WHERE user_id = ?').bind(re.enc, re.iv, r.user_id).run();
    apiKeys++;
  }
  const docs = (await env.DB.prepare('SELECT user_id, enc, iv FROM kyc_docs').all<{ user_id: number; enc: string; iv: string }>()).results ?? [];
  for (const r of docs) {
    const d = await aesDecryptAny(env, r.enc, r.iv).catch(() => null);
    if (!d || !d.usedPrev) continue;
    const re = await aesEncrypt(env.MASTER_KEY, d.plaintext);
    await env.DB.prepare('UPDATE kyc_docs SET enc = ?, iv = ?, key_ver = key_ver + 1 WHERE user_id = ?').bind(re.enc, re.iv, r.user_id).run();
    kycDocs++;
  }
  credsCache.clear();
  return { apiKeys, kycDocs };
}
