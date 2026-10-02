// 카피 트레이딩 API: 상태·고수 신청·승인·팔로우(자격·409)·설정·멈추기·대시보드 마스킹·관리자 게이트
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { AUTO_TERMS_VERSION, COPY_TERMS_VERSION, MASTER_TERMS_VERSION, TERMS_VERSION } from '@easy-futures/shared';
import type { AdminCopyResponse, CopyDashboardResponse, CopyMasterProfile, CopyStateResponse } from '@easy-futures/shared';
import { createUser } from '../db.js';
import { pbkdf2Hash, randomSalt } from '../crypto.js';
import { insertEvent, insertCopyExecution, upsertCopyPosition, upsertMasterState } from '../copy/db.js';
import { maskLoginId } from './copy.js';

const BASE = 'http://localhost/api';
let cookie = '';
async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await SELF.fetch(BASE + path, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) => call(path, { method: 'PUT', body: JSON.stringify(body) });
async function prices(p: Record<string, number>) { await env.PAPER.get(env.PAPER.idFromName('global')).fetch('https://paper/__test/prices', { method: 'POST', body: JSON.stringify(p) }); }
async function mkUser(loginId: string, uid: string, kyc = true) {
  const exists = await env.DB.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first<{ id: number }>();
  if (exists) return exists.id; // 같은 파일의 앞 테스트가 만든 사용자(관리자) 재사용
  const salt = randomSalt();
  const u = await createUser(env, loginId, await pbkdf2Hash('123456', salt), salt, uid, Date.now(), TERMS_VERSION);
  if (kyc) await env.DB.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").bind(u.id).run();
  return u.id;
}
const login = async (loginId: string) => { cookie = ''; const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ loginId, password: '123456' }) }); expect(r.status).toBe(200); };
const applyBody = { nickname: '고수철수', intro: '30일 수익 공개', agree: true, masterTermsVersion: MASTER_TERMS_VERSION };
const followBody = (masterId: number) => ({ masterId, copyAmount: 100, lossLimitPct: 50, maxLeverage: 10, slRoi: 30, agree: true, copyTermsVersion: COPY_TERMS_VERSION });

describe('copy trading routes', () => {
  // 시세는 격리환경에 1초 캐시되고 이 파일 전체가 1초 안에 돈다 → 첫 라우트 호출 전에 한 번만 주입 (장부 진입가 80,000 → BTC 미실현 +1 USDT/계약)
  beforeAll(async () => { await prices({ BTCUSDT: 81_000, ETHUSDT: 2_500, SOLUSDT: 100 }); });
  beforeEach(() => { cookie = ''; });

  it('masks login ids', () => {
    expect(maskLoginId('abcdef12')).toBe('ab***2');
    expect(maskLoginId('abcd')).toBe('a***');
    expect(maskLoginId('abcde')).toBe('ab***e');
  });

  it('state → apply (eligibility, terms) → admin approve → listed', async () => {
    const masterId = await mkUser('cpmaster1', '91241001');
    await login('cpmaster1');
    let r = await call('/copy');
    expect(r.status).toBe(200);
    let s = r.body as unknown as CopyStateResponse;
    expect(s.me.master).toBeNull(); expect(s.me.follow).toBeNull(); expect(s.masters).toEqual([]);
    expect(s.me.eligible).toEqual({ kyc: true, live: false, apiKey: false, autoOn: false, termsCurrent: true });

    // 약관 버전·동의·닉네임 검증
    r = await post('/copy/master/apply', { ...applyBody, agree: false });
    expect(r.status).toBe(400); expect(r.body.code).toBe('AGREE_REQUIRED');
    r = await post('/copy/master/apply', { ...applyBody, masterTermsVersion: 'old' });
    expect(r.status).toBe(400); expect(r.body.code).toBe('TERMS_OUTDATED');
    r = await post('/copy/master/apply', { ...applyBody, nickname: '가' });
    expect(r.body.code).toBe('BAD_NICKNAME');
    // 일반 사용자는 실거래 + API 키가 있어야 고수 신청 가능
    r = await post('/copy/master/apply', applyBody);
    expect(r.status).toBe(403); expect(r.body.code).toBe('LIVE_REQUIRED');
    await env.DB.prepare("UPDATE settings SET mode = 'live' WHERE user_id = ?").bind(masterId).run();
    await env.DB.prepare("INSERT OR IGNORE INTO settings (user_id, mode) VALUES (?, 'live')").bind(masterId).run();
    r = await post('/copy/master/apply', applyBody);
    expect(r.status).toBe(403); expect(r.body.code).toBe('NO_API_KEY');
    // 관리자는 연습 모드로도 신청 가능 (테스트용)
    await mkUser('adminuser', '91241002');
    await login('adminuser');
    r = await post('/copy/master/apply', { ...applyBody, nickname: '테스트고수' });
    expect(r.status).toBe(202); expect(r.body.status).toBe('pending');
    r = await post('/copy/master/apply', { ...applyBody, nickname: '테스트고수' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_MASTER_STATE');
    r = await call('/copy');
    s = r.body as unknown as CopyStateResponse;
    expect(s.me.master?.status).toBe('pending'); expect(s.me.master?.nickname).toBe('테스트고수');
    expect(s.masters).toEqual([]); // 승인 전엔 목록에 없다
    r = await put('/copy/master', { intro: '소개 수정' });
    expect(r.status).toBe(200);

    // 관리자 승인
    const adminId = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'adminuser'").first<{ id: number }>())!.id;
    r = await call('/admin/copy');
    expect(r.status).toBe(200);
    let a = r.body as unknown as AdminCopyResponse;
    expect(a.pending.map((m) => m.userId)).toEqual([adminId]);
    expect(a.pending[0].loginId).toBe('adminuser'); expect(a.pending[0].hasApiKey).toBe(false); expect(a.pending[0].mode).toBe('paper');
    r = await post(`/admin/copy/masters/${adminId}`, { action: 'approve' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('approved'); // 감시 DO 가 501 이어도 승인은 성공
    r = await post(`/admin/copy/masters/${adminId}`, { action: 'approve' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('BAD_TRANSITION');
    r = await call('/admin/copy');
    a = r.body as unknown as AdminCopyResponse;
    expect(a.approved.map((m) => m.userId)).toEqual([adminId]); expect(a.pending).toEqual([]);
    r = await call(`/admin/copy/masters/${adminId}/status`);
    expect(r.status).toBe(200); expect(typeof r.body.available).toBe('boolean'); expect(r.body.masterStatus).toBe('approved'); // 감시 DO 유무와 무관하게 200

    // 승인된 고수는 목록·프로필에 보인다 (프로필은 거래 내역이 비어도 200)
    await login('cpmaster1');
    r = await call('/copy');
    s = r.body as unknown as CopyStateResponse;
    expect(s.masters.map((m) => m.nickname)).toContain('테스트고수'); expect(s.masters.find((m) => m.userId === adminId)?.followers).toBe(0);
    r = await call(`/copy/masters/${adminId}`);
    expect(r.status).toBe(200);
    const p = r.body as unknown as CopyMasterProfile;
    expect(p.userId).toBe(adminId); expect(p.recent).toEqual([]); expect(p.intro).toBe('소개 수정');
    expect('days30Pnl' in p).toBe(false); // 공개 카드에 손익 금액 없음
    expect(s.masters.every((m) => !('days30Pnl' in m))).toBe(true);
    r = await call(`/copy/masters/${masterId}`);
    expect(r.status).toBe(404);
  });

  it('follow: self / not approved / auto on / already following / terms; unfollow; dashboard masking', async () => {
    const masterId = await mkUser('cpmaster2', '91241003');
    await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, decided_at, created_at) VALUES (?, '고수둘', NULL, 'approved', ?, 1, 2, 1)").bind(masterId, MASTER_TERMS_VERSION).run();
    const pendingId = await mkUser('cpmaster3', '91241004');
    await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, created_at) VALUES (?, '고수셋', NULL, 'pending', ?, 1, 1)").bind(pendingId, MASTER_TERMS_VERSION).run();
    const followerId = await mkUser('cpfollow1', '91241005');

    await login('cpfollow1');
    let r = await post('/copy/follow', { ...followBody(masterId), agree: false });
    expect(r.status).toBe(400); expect(r.body.code).toBe('AGREE_REQUIRED');
    r = await post('/copy/follow', { ...followBody(masterId), copyTermsVersion: 'old' });
    expect(r.status).toBe(400); expect(r.body.code).toBe('TERMS_OUTDATED');
    r = await post('/copy/follow', { ...followBody(masterId), lossLimitPct: 99 });
    expect(r.body.code).toBe('BAD_LOSS_LIMIT');
    r = await post('/copy/follow', { ...followBody(masterId), maxLeverage: 51 });
    expect(r.body.code).toBe('BAD_LEV');
    r = await post('/copy/follow', followBody(followerId));
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_SELF');
    r = await post('/copy/follow', followBody(pendingId));
    expect(r.status).toBe(404); expect(r.body.code).toBe('NO_MASTER');
    // AI 자동매매 켜져 있으면 409
    await env.DB.prepare('INSERT INTO auto_settings (user_id, enabled, pct, max_leverage, default_sl_roi, agreed_at, applied_at, updated_at, auto_terms_version) VALUES (?, 1, 10, 5, 20, 1, 1, 1, ?)').bind(followerId, AUTO_TERMS_VERSION).run();
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(409); expect(r.body.code).toBe('AUTO_ON');
    await env.DB.prepare('UPDATE auto_settings SET enabled = 0 WHERE user_id = ?').bind(followerId).run();
    // 따라갈 돈 > 연습 계좌 잔고(1000)
    r = await post('/copy/follow', { ...followBody(masterId), copyAmount: 5000 });
    expect(r.status).toBe(400); expect(r.body.code).toBe('INSUFFICIENT');
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(200); expect(r.body.ok).toBe(true);
    const followId = r.body.followId as number;
    expect(followId).toBeGreaterThan(0);
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(409); expect(r.body.code).toBe('ALREADY_FOLLOWING');

    // 장부 포지션 + 시세 → 미실현 (BTC 1계약 = 0.001 BTC, 80,000 → 81,000 = +1 USDT)
    await upsertCopyPosition(env.DB, { followerId, masterId, symbol: 'BTCUSDT', direction: 'long', contracts: 2, entryPrice: 80_000, leverage: 5, slPrice: 76_000, tpPrice: null });
    r = await call('/copy');
    let s = r.body as unknown as CopyStateResponse;
    expect(s.me.follow?.status).toBe('active'); expect(s.me.follow?.masterNickname).toBe('고수둘'); expect(s.me.follow?.mode).toBe('paper');
    expect(s.me.follow?.positions).toHaveLength(1); expect(s.me.follow?.positions[0].unrealizedPnl).toBeCloseTo(2, 2);
    expect(s.me.follow?.positions[0].stopLossPrice).toBe(76_000); expect(s.me.follow?.positions[0].takeProfitPrice).toBeNull();
    expect(s.me.follow?.unrealizedPnl).toBeCloseTo(2, 2); expect(s.me.follow?.lossLimitUsed).toBe(0);
    expect(s.masters.find((m) => m.userId === masterId)?.followers).toBe(1);
    expect(s.me.eligible.autoOn).toBe(false);

    // 설정 부분 변경
    r = await put('/copy/follow', { slRoi: 20 });
    expect(r.status).toBe(200); expect((r.body.settings as { slRoi: number; copyAmount: number }).slRoi).toBe(20);
    expect((r.body.settings as { copyAmount: number }).copyAmount).toBe(100);
    r = await put('/copy/follow', { copyAmount: 5000 });
    expect(r.status).toBe(400); expect(r.body.code).toBe('INSUFFICIENT');

    // 실행 내역 + 이벤트 (마스터 대시보드용)
    await insertEvent(env.DB, { id: `copy-${masterId}-BTCUSDT-1`, masterId, seq: 1, symbol: 'BTCUSDT', kind: 'open', direction: 'long', beforeContracts: 0, afterContracts: 10, price: 80_000, leverage: 5, masterEquity: 10_000, createdAt: Date.now() });
    await insertCopyExecution(env.DB, `copy-${masterId}-BTCUSDT-1`, followerId, 'paper', 'ok', null, 'paper-x-1', 2);
    await upsertMasterState(env.DB, masterId, { symbol: 'BTCUSDT', direction: 'long', contracts: 10, entryPrice: 80_000, leverage: 5, equity: 10_000 });
    r = await call('/copy/executions');
    expect(r.status).toBe(200);
    const execs = r.body.executions as { eventId: string; status: string; event?: { kind: string } }[];
    expect(execs).toHaveLength(1); expect(execs[0].status).toBe('ok'); expect(execs[0].event?.kind).toBe('open');

    // 마스터 대시보드: 승인 고수만, 아이디 마스킹, 감시 DO 없으면 meta 폴백
    r = await call('/copy/master/dashboard');
    expect(r.status).toBe(403);
    await login('cpmaster2');
    r = await call('/copy/master/dashboard');
    expect(r.status).toBe(200);
    const d = r.body as unknown as CopyDashboardResponse;
    expect(d.followers).toHaveLength(1);
    expect(d.followers[0].maskedId).toBe('cp***1'); expect(d.followers[0].positions).toHaveLength(1); expect(d.followers[0].unrealizedPnl).toBeCloseTo(2, 2);
    expect(d.followers[0].lastExecution?.status).toBe('ok');
    expect(d.events).toHaveLength(1); expect(d.stats.followers).toBe(1); expect(d.stats.positions).toEqual([{ symbol: 'BTCUSDT', direction: 'long' }]);
    expect(typeof d.watcher.wsOk).toBe('boolean'); expect('lastPollAt' in d.watcher && 'lastError' in d.watcher).toBe(true); // DO 응답 또는 meta 폴백 모두 같은 모양
    r = await call(`/copy/master/events/copy-${masterId}-BTCUSDT-1/executions`);
    expect(r.status).toBe(200);
    expect((r.body.executions as { loginId: string }[])[0].loginId).toBe('cp***1');
    await login('cpmaster3');
    r = await call(`/copy/master/events/copy-${masterId}-BTCUSDT-1/executions`);
    expect(r.status).toBe(403);

    // 멈추기 (정리 요청은 실행 DO 로 — DO 가 없으면 closed:false + 안내, 있으면 closed:true + 결과)
    await login('cpfollow1');
    r = await post('/copy/unfollow', { closePositions: true });
    expect(r.status).toBe(200); expect(typeof r.body.closed).toBe('boolean');
    if (r.body.closed) expect(r.body.result).toBeDefined(); else expect(typeof r.body.note).toBe('string');
    r = await post('/copy/unfollow', { closePositions: false });
    expect(r.status).toBe(404); expect(r.body.code).toBe('NOT_FOLLOWING');
    r = await call('/copy');
    s = r.body as unknown as CopyStateResponse;
    expect(s.me.follow?.status).toBe('stopped'); expect(s.me.follow?.stopReason).toBe('user'); expect(s.me.follow?.id).toBe(followId);
    expect(s.masters.find((m) => m.userId === masterId)?.followers).toBe(0);
    // 멈춘 뒤엔 다시 따라갈 수 있다
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(200);
  });

  it('admin: non-admin 403; suspend stops follows and keeps positions; follow stop', async () => {
    const masterId = await mkUser('cpmaster4', '91241006');
    await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, decided_at, created_at) VALUES (?, '고수넷', NULL, 'approved', ?, 1, 2, 1)").bind(masterId, MASTER_TERMS_VERSION).run();
    const f1 = await mkUser('cpfollow2', '91241007');
    const f2 = await mkUser('cpfollow3', '91241008');
    await login('cpfollow2');
    let r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(200);
    r = await call('/admin/copy');
    expect(r.status).toBe(403); expect(r.body.code).toBe('FORBIDDEN');
    r = await post(`/admin/copy/masters/${masterId}`, { action: 'suspend' });
    expect(r.status).toBe(403);
    await login('cpfollow3');
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(200);
    const f2Follow = r.body.followId as number;
    // 고수끼리 서로 따라할 수 없다 (신청·승인·중지 상태의 고수는 팔로워가 될 수 없음)
    const master2 = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'cpmaster2'").first<{ id: number }>())!.id;
    await login('cpmaster4');
    r = await post('/copy/follow', followBody(master2));
    expect(r.status).toBe(409); expect(r.body.code).toBe('COPY_CYCLE');
    await upsertCopyPosition(env.DB, { followerId: f1, masterId, symbol: 'ETHUSDT', direction: 'short', contracts: 3, entryPrice: 2_500, leverage: 3 });

    await mkUser('adminuser', '91241009');
    await login('adminuser');
    r = await post(`/admin/copy/follows/${f2Follow}/stop`, {});
    expect(r.status).toBe(200); expect(r.body.stopped).toBe(true);
    r = await post(`/admin/copy/masters/${masterId}`, { action: 'suspend', note: '검토 필요' });
    expect(r.status).toBe(200); expect(r.body.stoppedFollows).toBe(1);
    r = await call('/admin/copy');
    const a = r.body as unknown as AdminCopyResponse;
    expect(a.suspended[0].userId).toBe(masterId); expect(a.suspended[0].note).toBe('검토 필요');
    const rows = a.follows.filter((f) => f.masterNickname === '고수넷');
    expect(rows.map((f) => f.stopReason).sort()).toEqual(['admin', 'master_suspended']);
    expect(rows.every((f) => f.status === 'stopped')).toBe(true);
    // 거래소 포지션은 남지만 장부는 지운다 (이제 사용자 본인 포지션 — 다음 팔로우가 이어받지 않게)
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM copy_positions WHERE follower_id = ?').bind(f1).first<{ n: number }>())?.n).toBe(0);
    r = await post(`/admin/copy/masters/${masterId}/kick`, {});
    expect(r.status).toBe(200); expect(typeof r.body.ok).toBe('boolean'); // DO 결과를 그대로 보고 (미구현이면 ok:false)
    await login('cpfollow2');
    r = await call('/copy');
    const s = r.body as unknown as CopyStateResponse;
    expect(s.me.follow?.stopReason).toBe('master_suspended'); expect(s.masters.find((m) => m.userId === masterId)).toBeUndefined();
    r = await post('/copy/follow', followBody(masterId));
    expect(r.status).toBe(404);
  });
});

describe('admin stats reset', () => {
  it('sets per-metric since timestamps and recomputes; non-admin gets 403', async () => {
    await mkUser('adminuser', '91241902').catch(() => {});
    await login('adminuser');
    const adminId = (await env.DB.prepare("SELECT id FROM users WHERE login_id = 'adminuser'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT OR IGNORE INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, created_at) VALUES (?, 'rsmaster', '', 'approved', '2026-09-18', 1, 1)").bind(adminId).run();
    await env.DB.prepare('INSERT INTO copy_master_stats (master_id, days30_pnl, days30_roi, win_rate, trades, recent_json, updated_at) VALUES (?, 12.5, 3.1, 60, 5, ?, ?) ON CONFLICT(master_id) DO UPDATE SET trades = 5, win_rate = 60, days30_pnl = 12.5, updated_at = excluded.updated_at').bind(adminId, JSON.stringify([{ closedAt: 1, symbol: 'ETHUSDT', direction: 'long', roiPct: 1 }]), Date.now()).run();
    let r = await post(`/admin/copy/masters/${adminId}/reset-stats`, { which: 'nope' });
    expect(r.status).toBe(400);
    r = await post(`/admin/copy/masters/${adminId}/reset-stats`, { which: 'winRate' });
    expect(r.status).toBe(200); expect(r.body.which).toBe('winRate');
    const row = await env.DB.prepare('SELECT roi_since, winrate_since, recent_since, trades, win_rate FROM copy_master_stats WHERE master_id = ?').bind(adminId).first<{ roi_since: number; winrate_since: number; recent_since: number; trades: number; win_rate: number }>();
    expect(row!.winrate_since).toBeGreaterThan(0); expect(row!.roi_since).toBe(0); expect(row!.recent_since).toBe(0);
    expect(row!.trades).toBe(0); expect(row!.win_rate).toBe(0);   // 연습 계정에 마감 거래 없음 → 재계산 결과 0
    r = await post(`/admin/copy/masters/${adminId}/reset-stats`, { which: 'all' });
    const row2 = await env.DB.prepare('SELECT roi_since, recent_since FROM copy_master_stats WHERE master_id = ?').bind(adminId).first<{ roi_since: number; recent_since: number }>();
    expect(row2!.roi_since).toBeGreaterThan(0); expect(row2!.recent_since).toBeGreaterThan(0);
    await mkUser('rsplain', '91241903');
    await login('rsplain');
    r = await post(`/admin/copy/masters/${adminId}/reset-stats`, { which: 'roi' });
    expect(r.status).toBe(403);
  });
});

describe('master hide (공개 숨김)', () => {
  it('PUT /copy/master/hide validates and persists; public card/profile omit hidden fields; self, dashboard and admin keep them', async () => {
    const masterId = await mkUser('cphide1', '91241950');
    await env.DB.prepare("INSERT INTO copy_masters (user_id, nickname, intro, status, terms_version, applied_at, decided_at, created_at) VALUES (?, '숨김고수', NULL, 'approved', ?, 1, 2, 1)").bind(masterId, MASTER_TERMS_VERSION).run();
    await env.DB.prepare('INSERT INTO copy_master_stats (master_id, days30_pnl, days30_roi, win_rate, trades, recent_json, updated_at) VALUES (?, 5, 2.5, 70, 10, ?, ?)').bind(masterId, JSON.stringify([{ closedAt: 1, symbol: 'BTCUSDT', direction: 'long', roiPct: 3 }]), Date.now()).run();
    await mkUser('cphide2', '91241951');

    // 고수가 아니면 404
    await login('cphide2');
    let r = await put('/copy/master/hide', { hide: { roi: true } });
    expect(r.status).toBe(404); expect(r.body.code).toBe('NOT_MASTER');

    // 고수: true/false 만, 부분 갱신
    await login('cphide1');
    r = await put('/copy/master/hide', { hide: { roi: 'yes' } });
    expect(r.status).toBe(400); expect(r.body.code).toBe('BAD_HIDE');
    r = await put('/copy/master/hide', { hide: 'nope' });
    expect(r.status).toBe(400);
    r = await put('/copy/master/hide', { hide: { roi: true, followers: true, recent: true } });
    expect(r.status).toBe(200); expect(r.body.hide).toEqual({ followers: true, trades: false, winRate: false, roi: true, recent: true });
    r = await put('/copy/master/hide', { hide: { trades: true } });
    expect(r.status).toBe(200); expect(r.body.hide).toEqual({ followers: true, trades: true, winRate: false, roi: true, recent: true });

    // 본인: 상태(hide)·목록 카드·프로필·대시보드에 숨긴 값도 그대로
    r = await call('/copy');
    let s = r.body as unknown as CopyStateResponse;
    expect(s.me.master?.hide).toEqual({ followers: true, trades: true, winRate: false, roi: true, recent: true });
    const mine = s.masters.find((m) => m.userId === masterId)!;
    expect(mine.days30Roi).toBe(2.5); expect(mine.followers).toBe(0); expect(mine.trades).toBe(10); expect(mine.winRate).toBe(70);
    r = await call(`/copy/masters/${masterId}`);
    let p = r.body as unknown as CopyMasterProfile;
    expect(r.status).toBe(200); expect(p.recent).toHaveLength(1); expect(p.days30Roi).toBe(2.5);
    r = await call('/copy/master/dashboard');
    const d = r.body as unknown as CopyDashboardResponse;
    expect(r.status).toBe(200); expect(d.stats.days30Roi).toBe(2.5); expect(d.stats.trades).toBe(10); expect(d.stats.followers).toBe(0); expect(d.stats.hide.roi).toBe(true);

    // 다른 사용자: 숨긴 항목은 키 자체가 없고, hide 로 무엇이 비공개인지만 안다
    await login('cphide2');
    r = await call('/copy');
    s = r.body as unknown as CopyStateResponse;
    const pub = s.masters.find((m) => m.userId === masterId)!;
    expect('days30Roi' in pub).toBe(false); expect('followers' in pub).toBe(false); expect('trades' in pub).toBe(false); expect('days30Pnl' in pub).toBe(false);
    expect(pub.winRate).toBe(70); expect(pub.hide).toEqual({ followers: true, trades: true, winRate: false, roi: true, recent: true });
    r = await call(`/copy/masters/${masterId}`);
    p = r.body as unknown as CopyMasterProfile;
    expect(r.status).toBe(200);
    expect('recent' in p).toBe(false); expect('days30Roi' in p).toBe(false); expect('followers' in p).toBe(false); expect(p.winRate).toBe(70);

    // 관리자 카드는 운영을 위해 팔로워 수를 계속 본다
    await mkUser('adminuser', '91241952');
    await login('adminuser');
    r = await call('/admin/copy');
    expect(r.status).toBe(200);
    const a = r.body as unknown as AdminCopyResponse;
    expect(a.approved.find((m) => m.userId === masterId)?.followers).toBe(0);
  });
});
