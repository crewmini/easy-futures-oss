// /api/partner — 제휴사(영업 담당자) 페이지: 내 코드, 고객 목록 + 실시간 포지션, UID 로 고객 추가
// /api/admin/partners — 관리자가 제휴사 지정/목록
import { Hono } from 'hono';
import type { PartnerMember, Position, Symbol, Wallet } from '@easy-futures/shared';
import { WooxAdapter } from '../adapters/woox.js';
import { authMiddleware, type AppEnv } from '../auth.js';
import { createPartner, decidePartnerApplication, findUserById, findUserByLogin, findUserByUid, getCredsForUser, getPartnerApplication, getPartnerByUser, getSettings, listPartnerApplications, listPartnerMembers, listPartners, removePartner, savePartnerApplication, setUserPartner } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { parseUserIdParam, validatePartnerApplication, validateUid } from '../validate.js';
import { WooxClient } from '../woox/client.js';
import { isAdmin } from './auth.js';

/** 제휴사 신청(로그인한 누구나). 승인 전까지 제휴사 페이지는 열리지 않는다. */
export const partnerApplyRoutes = new Hono<AppEnv>();
partnerApplyRoutes.use('*', authMiddleware);
partnerApplyRoutes.get('/', async (c) => {
  const ctx = c.get('ctx');
  const [app, partner] = await Promise.all([getPartnerApplication(c.env.DB, ctx.user.id), getPartnerByUser(c.env.DB, ctx.user.id)]);
  return c.json({ status: partner ? 'approved' : (app?.status ?? 'none'), application: app ? { company: app.company, name: app.name, phone: app.phone, submittedAt: app.submitted_at, note: app.note } : null });
});
partnerApplyRoutes.post('/', async (c) => {
  const ctx = c.get('ctx');
  if (await getPartnerByUser(c.env.DB, ctx.user.id)) return c.json({ ok: true, status: 'approved' });
  const a = validatePartnerApplication(await readJson(c));
  await savePartnerApplication(c.env.DB, ctx.user.id, a);
  log.info('partner application submitted', { userId: ctx.user.id, company: a.company });
  return c.json({ ok: true, status: 'pending' });
});

export const partnerRoutes = new Hono<AppEnv>();
partnerRoutes.use('*', authMiddleware, async (c, next) => {
  const p = await getPartnerByUser(c.env.DB, c.get('ctx').user.id);
  if (!p) throw new HttpError(403, '제휴사로 지정된 계정만 볼 수 있어요', 'NOT_PARTNER');
  c.set('partner', p);
  await next();
});

partnerRoutes.get('/me', (c) => c.json({ code: c.get('partner').code }));

/** 고객 목록 + 각자의 현재 포지션. 고객 한 명당 거래소 호출 2회(고객 본인 키) — 서로 독립이라 병렬. */
partnerRoutes.get('/members', async (c) => {
  const partner = c.get('partner');
  const env = c.env;
  const paper = new PaperClient(env);
  const [allRows, contracts, pr] = await Promise.all([listPartnerMembers(env.DB, partner.user_id), getContracts(), paper.prices()]);
  const rows = allRows.slice(0, 50); // 응답당 50명까지 (거래소 호출 폭주 방지)
  const members: PartnerMember[] = await Promise.all(rows.map(async (u): Promise<PartnerMember> => {
    const base = { userId: u.id, loginId: u.login_id, uid: u.uid, kycStatus: u.kyc_status, joinedAt: u.created_at, autoStatus: ((u as { auto_status?: string }).auto_status ?? 'none') as PartnerMember['autoStatus'] };
    try {
      const settings = await getSettings(env, u.id);
      let wallet: Wallet | null = null; let positions: Position[] = []; let hasKey = false;
      if (settings.mode === 'live') {
        const creds = await getCredsForUser(env, u.id);
        if (!creds) return { ...base, mode: 'live', hasApiKey: false, wallet: null, positions: [], error: 'API 키 없음' };
        hasKey = true;
        const acc = await new WooxAdapter(new WooxClient({ credentials: creds, gate: makeRateGate(c.env) })).getAccount(contracts, pr.prices);
        wallet = acc.wallet; positions = acc.positions;
      } else {
        const s = await paper.state(u.id);
        wallet = s.wallet; positions = s.positions;
      }
      return { ...base, mode: settings.mode, hasApiKey: hasKey, wallet, positions, error: null };
    } catch (e) {
      log.warn('partner member fetch failed', { userId: u.id, message: (e as Error).message });
      return { ...base, mode: 'live', hasApiKey: false, wallet: null, positions: [], error: '조회 실패' };
    }
  }));
  return c.json({ members, prices: pr.prices, serverTime: Date.now() });
});

const linkAttempts = new Map<number, number[]>();
/** UID 로 고객 수동 연결 (코드 없이 가입한 고객). 제휴사당 분당 10회로 제한(UID 무작위 대입 완화) */
partnerRoutes.post('/members', async (c) => {
  const partner = c.get('partner');
  const now = Date.now();
  const recent = (linkAttempts.get(partner.user_id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) throw new HttpError(429, '너무 빨리 시도했어요. 1분 뒤 다시 해 주세요', 'TOO_MANY');
  recent.push(now); linkAttempts.set(partner.user_id, recent);
  const uid = validateUid((await readJson(c)).uid);
  const user = await findUserByUid(c.env.DB, uid);
  if (!user) throw new HttpError(404, '그 UID로 가입한 고객이 없어요. 고객이 먼저 가입해야 해요', 'NO_USER');
  if (user.partner_id && user.partner_id !== partner.user_id) throw new HttpError(409, '이미 다른 제휴사에 연결된 고객이에요. 관리자에게 문의하세요', 'OTHER_PARTNER');
  await setUserPartner(c.env.DB, user.id, partner.user_id);
  log.info('partner linked member', { partner: partner.user_id, userId: user.id });
  return c.json({ ok: true, loginId: user.login_id });
});

partnerRoutes.delete('/members/:userId', async (c) => {
  const partner = c.get('partner');
  const userId = parseUserIdParam(c.req.param('userId'));
  const rows = await listPartnerMembers(c.env.DB, partner.user_id);
  if (!rows.some((r) => r.id === userId)) throw new HttpError(404, '내 고객이 아니에요', 'NO_MEMBER');
  await setUserPartner(c.env.DB, userId, null);
  return c.json({ ok: true });
});

export const adminPartnerRoutes = new Hono<AppEnv>();
adminPartnerRoutes.use('*', authMiddleware, async (c, next) => {
  if (!isAdmin(c.env, c.get('ctx').user.loginId)) throw new HttpError(403, '관리자만 볼 수 있어요', 'FORBIDDEN');
  await next();
});
adminPartnerRoutes.get('/', async (c) => {
  const [rows, apps] = await Promise.all([listPartners(c.env.DB), listPartnerApplications(c.env.DB, 'pending')]);
  return c.json({
    partners: rows.map((r) => ({ userId: r.user_id, loginId: r.login_id, code: r.code, members: Number(r.members), createdAt: r.created_at, company: r.company ?? null, name: r.name ?? null, phone: r.phone ?? null })),
    applications: apps.map((a) => ({ userId: a.user_id, loginId: a.login_id, uid: a.uid, company: a.company, name: a.name, phone: a.phone, submittedAt: a.submitted_at })),
  });
});
/** 신청 승인/거절. 승인하면 코드가 생기고 신청서의 소속·이름·전화가 제휴사 정보로 복사된다. */
adminPartnerRoutes.post('/applications/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  const b = await readJson(c);
  const action = b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : null;
  if (!action) throw badRequest('approve 또는 reject', 'BAD_ACTION');
  const app = await getPartnerApplication(c.env.DB, userId);
  if (!app) throw new HttpError(404, '신청이 없어요', 'NO_APPLICATION');
  const by = c.get('ctx').user.loginId;
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : null;
  let code: string | null = null;
  if (action === 'approved') code = (await createPartner(c.env.DB, userId, { company: app.company, name: app.name, phone: app.phone })).code;
  await decidePartnerApplication(c.env.DB, userId, action, action === 'rejected' ? (note || '제휴사 승인이 거절되었어요') : null, by);
  log.info('partner application decided', { userId, action, by });
  return c.json({ ok: true, status: action, code });
});
/** 제휴사 제거 (코드 삭제 + 고객 연결 해제) */
adminPartnerRoutes.delete('/:userId', async (c) => {
  const userId = parseUserIdParam(c.req.param('userId'));
  if (!(await findUserById(c.env.DB, userId))) throw new HttpError(404, '사용자가 없어요', 'NO_USER');
  await removePartner(c.env.DB, userId, c.get('ctx').user.loginId);
  log.info('partner removed', { userId, by: c.get('ctx').user.loginId });
  return c.json({ ok: true });
});
adminPartnerRoutes.post('/', async (c) => {
  const b = await readJson(c);
  const loginId = typeof b.loginId === 'string' ? b.loginId.trim() : '';
  if (!loginId) throw badRequest('아이디를 넣어 주세요', 'BAD_LOGIN_ID');
  const user = await findUserByLogin(c.env.DB, loginId);
  if (!user) throw new HttpError(404, '그 아이디의 회원이 없어요', 'NO_USER');
  const p = await createPartner(c.env.DB, user.id);
  log.info('partner created', { userId: user.id, by: c.get('ctx').user.loginId });
  return c.json({ ok: true, code: p.code, loginId });
});
// (Symbol 타입은 시세 필드 타이핑용으로만 참조)
export type _PricesKey = Symbol;
