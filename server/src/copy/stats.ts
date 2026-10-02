// 고수 통계(30일 손익·수익률·승률·거래 수·최근 마감 10건) 갱신 — D1 copy_master_stats.updated_at 5분 게이트.
// 프로필 라우트와 MasterWatcher 알람(≈5분마다)이 같은 함수를 부른다. 아이솔레이트 Map 캐시는 쓰지 않는다 (여러 아이솔레이트가 각각 거래소를 부르지 않게).
import type { ContractInfo, Price, Symbol, TradeHistoryItem } from '@easy-futures/shared';
import type { Env } from '../env.js';
import { findUserById, getCredsForUser, getSettings, type UserContext } from '../db.js';
import { enrichHistory } from '../history.js';
import { log } from '../log.js';
import { getContracts } from '../market.js';
import { PaperClient } from '../paper/client.js';
import { adapterFor } from '../routes/trade.js';
import { getMasterStats, upsertMasterStats, type MasterRecentTrade, type MasterStats } from './db.js';

export const STATS_TTL_MS = 5 * 60_000;
type Prices = Partial<Record<Symbol, Price>>;
type Contracts = Record<Symbol, ContractInfo>;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 다른 사용자(마스터)의 컨텍스트 — 거래 내역 읽기 전용. 세션 없음 */
export async function contextOf(env: Env, userId: number): Promise<UserContext | null> {
  const user = await findUserById(env.DB, userId);
  if (!user || user.deleted_at) return null;
  const [settings, creds] = await Promise.all([getSettings(env, userId), getCredsForUser(env, userId)]);
  return {
    user: { id: user.id, loginId: user.login_id, uid: user.uid ?? null, kycStatus: (user.kyc_status ?? 'none') as UserContext['user']['kycStatus'], kycNote: user.kyc_note ?? null, mustChangePw: !!user.must_change_pw, termsVersion: user.terms_version ?? null },
    settings, creds, apiKeyPreview: null, sessionToken: '',
  };
}

/** 마감 거래 → 내 돈 기준 % (진입가는 정리가·손익으로 역산, 배율 없으면 1배 = 가격 변동률) */
export function closedRoi(it: TradeHistoryItem, contracts: Contracts): number | null {
  const qty = it.contracts * (contracts[it.symbol]?.contractSize ?? 0);
  const net = it.netPnl ?? it.pnl;
  if (!(qty > 0) || net == null || !(it.price > 0)) return null;
  const rawPnl = it.pnl ?? net;
  const entry = it.direction === 'long' ? it.price - rawPnl / qty : it.price + rawPnl / qty;
  const lev = it.leverage && it.leverage > 0 ? it.leverage : 1;
  const margin = (qty * entry) / lev;
  return margin > 0 ? r2((net / margin) * 100) : null;
}

/** 거래소를 불러 통계를 다시 계산하고 D1 에 저장. 실패는 던진다 (호출자가 잡는다) */
export async function recomputeMasterStats(env: Env, masterId: number): Promise<MasterStats> {
  const ctx = await contextOf(env, masterId);
  if (!ctx) throw new Error('사용자 없음');
  const paper = new PaperClient(env);
  const [contracts, pr] = await Promise.all([getContracts(), paper.prices().catch(() => ({ prices: {} as Prices }))]);
  const adapter = adapterFor(ctx, paper);
  const items = enrichHistory(await adapter.getHistory(30, contracts));
  const allCloses = items.filter((i) => i.kind !== 'open').sort((a, b) => b.time - a.time);
  // 관리자 초기화 기준 시각 이후 마감 거래만 각 지표에 반영
  const since = (await getMasterStats(env.DB, masterId))?.since ?? { roi: 0, winRate: 0, recent: 0 };
  const closes = allCloses.filter((i) => i.time > since.roi);
  const wrCloses = allCloses.filter((i) => i.time > since.winRate);
  const pnl = r2(closes.reduce((a, i) => a + (i.netPnl ?? i.pnl ?? 0), 0));
  const wins = wrCloses.filter((i) => (i.netPnl ?? i.pnl ?? 0) > 0).length;
  let equity = 0;
  try { equity = (await adapter.getAccount(contracts, pr.prices)).wallet.equity; } catch (e) { log.warn('copy master equity fetch failed', { masterId, message: (e as Error).message }); }
  const recent: MasterRecentTrade[] = allCloses.filter((i) => i.time > since.recent).slice(0, 10).map((i) => ({ closedAt: i.time, symbol: i.symbol, direction: i.direction, roiPct: closedRoi(i, contracts) ?? 0 }));
  const stats: Omit<MasterStats, 'updatedAt'> = { days30Pnl: pnl, days30Roi: equity > 0 ? r2((pnl / equity) * 100) : 0, winRate: wrCloses.length ? r2((wins / wrCloses.length) * 100) : 0, trades: wrCloses.length, recent };
  await upsertMasterStats(env.DB, masterId, stats);
  return { ...stats, updatedAt: Date.now(), since };
}

/** 5분 안에 갱신된 통계가 있으면 그대로, 없으면 다시 계산. 계산 실패 시 옛 값(없으면 null) */
export async function refreshMasterStats(env: Env, masterId: number, force = false): Promise<MasterStats | null> {
  const cur = await getMasterStats(env.DB, masterId);
  if (!force && cur && Date.now() - cur.updatedAt < STATS_TTL_MS) return cur;
  try { return await recomputeMasterStats(env, masterId); }
  catch (e) { log.warn('copy master stats refresh failed', { masterId, message: (e as Error).message }); return cur; }
}
