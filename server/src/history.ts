// 거래 내역 가공: 순손익(진입 수수료 배분), 출처(자동매매/직접) 판정, 기간·출처별 합계, 달력용 일별 손익
import type { DailyPnl, HistorySummary, Symbol, TradeHistoryItem, TradeSource } from '@easy-futures/shared';

export interface AutoTag { signalId: string }
/** 주문 id → 자동매매 신호. auto_executions 에서 만든다 */
export type AutoTags = Map<string, AutoTag>;
/** 주문 id → 카피 트레이딩 이벤트. copy_executions 에서 만든다 (copy/db.ts loadCopyTags) */
export type CopyTags = Map<string, { eventId: string }>;

const r2 = (v: number) => Math.round(v * 100) / 100;
/** 고수 따라하기 실행기의 주문 표식: cp<마스터>s<seq>f<팔로워>, cp<마스터>L…, cpS…, cpU… (copy/db.ts copyClientOrderId, CopyTrader closeBooks) */
export const isCopyClientOrderId = (id: string | null | undefined): boolean => typeof id === 'string' && /^cp\d/.test(id) || (typeof id === 'string' && /^cp[SU]\d/.test(id));
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * 종목별 시간순으로 훑으며
 * - 정리 행에 짝이 되는 진입 수수료를 배분해 순손익을 계산하고
 * - 포지션 흐름(0 → 보유 → 0)마다 출처를 정한다: 흐름 안의 진입이 전부 자동매매면 auto, 전부 카피면 copy, 전부 직접이면 manual, 섞이면 mixed.
 *   정리·손절·익절·강제정리 행은 자기 흐름의 출처를 물려받는다.
 * 반환은 입력과 같은 배열(정렬 유지). 각 행에 openFee/netPnl/source/signalId 를 채운다.
 */
export function enrichHistory(items: TradeHistoryItem[], tags: AutoTags = new Map(), copyTags: CopyTags = new Map()): TradeHistoryItem[] {
  const asc = [...items].sort((a, b) => a.time - b.time);
  interface Cycle { qty: number; feePool: number; auto: boolean; manual: boolean; copy: boolean; rows: TradeHistoryItem[] }
  const cycles: Partial<Record<Symbol, Cycle>> = {};
  const finish = (cy: Cycle) => {
    // 자동매매가 낀 흐름만 '혼합'. 카피 + 직접(주로 편입·복구로 기록이 빠진 카피 주문)은 '고수 따라하기' 로 — 자동매매를 한 적 없는 팔로워에게 'AI 자동매매' 로 보이던 오류 방지
    const src: TradeSource = cy.auto ? ((cy.manual || cy.copy) ? 'mixed' : 'auto') : cy.copy ? 'copy' : 'manual';
    for (const row of cy.rows) row.source = src;
  };
  for (const it of asc) {
    let cy = cycles[it.symbol];
    if (it.kind === 'open') {
      if (!cy || cy.qty <= 0) { cy = { qty: 0, feePool: 0, auto: false, manual: false, copy: false, rows: [] }; cycles[it.symbol] = cy; }
      const tag = it.orderId ? tags.get(it.orderId) : undefined;
      // 카피 판정: 실행 기록의 주문 id 매칭 → 없으면 주문 표식(client_order_id) 접두 'cp' (복구·편입된 실행은 기록에 주문 id 가 없을 수 있다 — 한 팔로워 사례 2026-09-28)
      const copyTag = (it.orderId ? copyTags.get(it.orderId) : undefined) ?? (isCopyClientOrderId(it.clientOrderId) ? { eventId: '' } : undefined);
      if (tag) { cy.auto = true; it.signalId = tag.signalId; } else if (copyTag) cy.copy = true; else cy.manual = true;
      cy.qty += it.contracts; cy.feePool += it.fee ?? 0; cy.rows.push(it);
      continue;
    }
    if (!cy) { cy = { qty: 0, feePool: 0, auto: false, manual: true, copy: false, rows: [] }; cycles[it.symbol] = cy; } // 기간 밖에서 연 포지션의 정리
    const share = cy.qty > 0 ? Math.min(1, it.contracts / cy.qty) : 0;
    const openFee = r4(cy.feePool * share);
    cy.feePool -= openFee; cy.qty = Math.max(0, cy.qty - it.contracts);
    it.openFee = openFee;
    it.netPnl = it.pnl == null ? null : r4(it.pnl - openFee - (it.fee ?? 0));
    cy.rows.push(it);
    if (cy.qty <= 0) { finish(cy); cycles[it.symbol] = undefined; }
  }
  for (const cy of Object.values(cycles)) if (cy) finish(cy); // 아직 열린 흐름
  return items;
}

export function summarize(items: TradeHistoryItem[]): HistorySummary {
  const closed = items.filter((i) => i.kind !== 'open');
  const realizedPnl = r2(closed.reduce((a, i) => a + (i.pnl ?? 0), 0));
  const totalFees = r2(items.reduce((a, i) => a + (i.fee ?? 0), 0));
  return { realizedPnl, totalFees, netPnl: r2(realizedPnl - totalFees), closedCount: closed.length };
}

/** 출처별 합계. 혼합 흐름은 자동매매 쪽으로 (자동매매가 개입한 돈은 자동매매 성과로 본다). copy = 고수 따라하기 흐름 */
export function summarizeBySource(items: TradeHistoryItem[]): Record<'auto' | 'manual', HistorySummary> & { copy: HistorySummary } {
  return {
    auto: summarize(items.filter((i) => i.source === 'auto' || i.source === 'mixed')),
    manual: summarize(items.filter((i) => i.source === 'manual' || !i.source)),
    copy: summarize(items.filter((i) => i.source === 'copy')),
  };
}

export function kstDate(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 달력용: KST 날짜별 순손익·수수료·정리 횟수 (정리 행 기준) */
export function dailyPnl(items: TradeHistoryItem[]): DailyPnl[] {
  const map = new Map<string, DailyPnl>();
  for (const it of items) {
    const key = kstDate(it.time);
    const d = map.get(key) ?? { date: key, netPnl: 0, totalFees: 0, closedCount: 0, auto: 0, manual: 0 };
    d.totalFees = r4(d.totalFees + (it.fee ?? 0));
    if (it.kind !== 'open') {
      d.closedCount++;
      const net = it.netPnl ?? ((it.pnl ?? 0) - (it.fee ?? 0));
      d.netPnl = r4(d.netPnl + net);
      if (it.source === 'auto' || it.source === 'mixed' || it.source === 'copy') d.auto = r4(d.auto + net); else d.manual = r4(d.manual + net); // 달력은 자동/직접 두 칸뿐 — 카피는 자동 쪽에
    } else if (it.fee) {
      // 진입 수수료는 정리 행의 순손익에 이미 배분됐다 — 여기서는 합계에만 반영하지 않는다
    }
    map.set(key, d);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 자동매매 실행(진입 주문 id) → 그 흐름의 실현 순손익. 흐름이 아직 안 닫혔으면 closed=false, pnl=지금까지 정리분 */
export function pnlByOrder(items: TradeHistoryItem[]): Map<string, { pnl: number | null; closed: boolean }> {
  const out = new Map<string, { pnl: number | null; closed: boolean }>();
  const asc = [...items].sort((a, b) => a.time - b.time);
  const open: Partial<Record<Symbol, { orderIds: string[]; net: number; qty: number; any: boolean }>> = {};
  for (const it of asc) {
    let cy = open[it.symbol];
    if (it.kind === 'open') {
      if (!cy || cy.qty <= 0) { cy = { orderIds: [], net: 0, qty: 0, any: false }; open[it.symbol] = cy; }
      if (it.orderId) cy.orderIds.push(it.orderId);
      cy.qty += it.contracts;
      continue;
    }
    if (!cy) continue;
    cy.qty = Math.max(0, cy.qty - it.contracts);
    if (it.netPnl != null) { cy.net = r4(cy.net + it.netPnl); cy.any = true; }
    const closed = cy.qty <= 0;
    for (const id of cy.orderIds) out.set(id, { pnl: cy.any ? cy.net : null, closed });
    if (closed) open[it.symbol] = undefined;
  }
  for (const cy of Object.values(open)) if (cy) for (const id of cy.orderIds) if (!out.has(id)) out.set(id, { pnl: null, closed: false });
  return out;
}
