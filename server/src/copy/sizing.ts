// 카피 트레이딩 비례 크기 계산 — 순수 함수 (docs/copy-trading.md §3)
// 마스터가 자기 자산의 r 비율을 증거금으로 썼으면, 팔로워도 "따라갈 돈"의 r 비율을 쓴다. 배율은 마스터 배율을 따르되 팔로워 상한·거래소 상한으로 자른다.

export interface ContractLike { contractSize: number; maxLeverage: number; minVolume: number }

export interface EntrySizingInput {
  masterDelta: number;        // 마스터가 이번에 늘린 계약 수 (> 0)
  price: number;              // 이벤트 시점 가격 (마크)
  masterLeverage: number;     // 마스터 배율
  masterEquity: number;       // 마스터 총자산 (이벤트 직전)
  copyAmountNow: number;      // 팔로워 "따라갈 돈" (실현손익 반영)
  available: number;          // 팔로워 지금 쓸 수 있는 돈
  followerMaxLeverage: number;
  fixedLeverage?: number;     // 있으면 이 배율 고정 (기존 같은 방향 포지션의 배율)
  contract: ContractLike;
}
export interface EntrySizing {
  contracts: number;          // 0 이면 진입 안 함 (reason 참고)
  leverage: number;
  marginUsdt: number;         // 실제로 쓰는 내 돈
  ratio: number;              // 마스터 증거금 비율 r (0~1)
  cappedByAvailable: boolean; // 쓸 수 있는 돈이 모자라 줄였는가
  reason: string | null;      // 0 계약일 때 사람이 읽을 사유
}

const round2 = (v: number) => Math.floor(v * 100) / 100;
export const TAKER_FEE = 0.0005;   // 진입·정리 각각 명목의 0.05% (수수료 여유·실현손익 추정에 공용)

export function entrySizing(i: EntrySizingInput): EntrySizing {
  const none = (reason: string, ratio = 0): EntrySizing => ({ contracts: 0, leverage: 1, marginUsdt: 0, ratio, cappedByAvailable: false, reason });
  if (!(i.masterDelta > 0) || !(i.price > 0)) return none('마스터 변화량 없음');
  if (!(i.masterEquity > 0)) return none('마스터 자산 정보 없음');
  const masterLev = Math.max(1, Math.floor(i.masterLeverage || 1));
  const masterMargin = (i.masterDelta * i.contract.contractSize * i.price) / masterLev;
  const ratio = Math.min(1, masterMargin / i.masterEquity);
  if (!(ratio > 0)) return none('마스터 증거금 비율 0');
  // fixedLeverage: 이미 같은 방향 포지션이 있으면(불타기) 거래소가 배율 변경을 막을 수 있어 그 포지션의 배율을 그대로 쓴다
  const leverage = i.fixedLeverage && i.fixedLeverage >= 1 ? Math.floor(i.fixedLeverage) : Math.max(1, Math.min(masterLev, Math.floor(i.followerMaxLeverage || 1), Math.floor(i.contract.maxLeverage || masterLev)));
  let margin = round2(ratio * Math.max(0, i.copyAmountNow));
  let capped = false;
  // 쓸 수 있는 돈으로 자를 때는 테이커 수수료(명목의 0.05%) 자리를 남긴다 — 딱 맞춰 넣으면 거래소가 잔고 부족으로 거절
  const maxMargin = round2(Math.max(0, i.available) / (1 + TAKER_FEE * leverage));
  if (margin > maxMargin) { margin = maxMargin; capped = true; }
  if (!(margin > 0)) return none('쓸 수 있는 돈 없음', ratio);
  const perContract = (i.contract.contractSize * i.price) / leverage;   // 1계약에 드는 내 돈
  const contracts = Math.floor(margin / perContract);
  const minVol = Math.max(1, Math.floor(i.contract.minVolume || 1));
  if (contracts < minVol) return { contracts: 0, leverage, marginUsdt: 0, ratio, cappedByAvailable: capped, reason: `금액이 너무 적음 — ${minVol}계약에 내 돈 ${round2(perContract * minVol)} USDT 필요 (지금 ${margin} USDT)` };
  return { contracts, leverage, marginUsdt: round2(contracts * perContract), ratio, cappedByAvailable: capped, reason: null };
}

export interface ReduceSizing { contracts: number; carry: number }
export const REDUCE_CARRY_DETAIL = (carry: number) => `고수가 줄인 비율이 1계약 미만 — 다음 축소에 합산 (이월 ${carry.toFixed(1)}계약)`;
/**
 * 마스터가 before → after 로 줄였을 때 팔로워 장부(bookContracts)에서 정리할 계약 수. 마스터가 0 이 되면 전량(이월 무관).
 * 정확한 비례 수량 = 장부 × (1 − after/before) + 이월(carry). 정수 계약만 정리하고 1계약 미만 나머지는 carry 로 돌려준다 —
 * 장부 1~2계약 팔로워가 고수의 5% 축소에 전량 정리되지 않게 (2026-09-22). 호출자는 carry 를 장부(copy_positions.reduce_carry)에 보관하고
 * 전량 정리·추가 진입 때 0 으로 되돌린다
 */
export function reduceContracts(before: number, after: number, bookContracts: number, carry = 0): ReduceSizing {
  const book = Math.max(0, Math.floor(bookContracts));
  const c0 = Number.isFinite(carry) && carry > 0 ? Math.min(carry, 0.999999) : 0;
  if (book === 0) return { contracts: 0, carry: 0 };
  if (!(before > 0) || after <= 0) return { contracts: book, carry: 0 };
  if (after >= before) return { contracts: 0, carry: c0 };
  const fraction = 1 - after / before;
  const exact = book * fraction + c0;
  const n = Math.min(book, Math.floor(exact + 1e-9));   // 장부를 넘지 않는다 (장부가 비면 행이 지워져 남는 이월은 쓰이지 않는다)
  const rest = exact - n;
  return { contracts: n, carry: rest < 1e-9 ? 0 : Math.round(rest * 1e6) / 1e6 };
}

/** 손실 한도 사용률 (0~1+). realized + unrealized 가 음수일 때만 의미 */
export function lossLimitUsed(copyAmount: number, lossLimitPct: number, realizedPnl: number, unrealizedPnl: number): number {
  const limit = copyAmount * (lossLimitPct / 100);
  if (!(limit > 0)) return 0;
  const loss = -(realizedPnl + unrealizedPnl);
  return loss <= 0 ? 0 : loss / limit;
}

/** 새 진입(또는 추가)으로 합쳐진 평단 */
export function mergedEntry(oldContracts: number, oldEntry: number, addContracts: number, addPrice: number): number {
  const total = oldContracts + addContracts;
  if (!(total > 0)) return addPrice;
  return (oldContracts * oldEntry + addContracts * addPrice) / total;
}

// ---------- 진입 가드 (나중에 팔로우별 설정으로 옮길 수 있게 상수로) ----------
/** 신호가 이보다 오래됐으면 진입하지 않는다 (고수 체결 → 팔로워 진입 사이 지연 상한) */
export const ENTRY_MAX_AGE_MS = 10_000;
/** 고수 체결가 대비 지금 마크가 이 비율 넘게 움직였으면 진입하지 않는다 (0.005 = 0.5%) */
export const ENTRY_MAX_DRIFT = 0.005;
export const ENTRY_STALE_DETAIL = '신호가 오래돼 진입하지 않았어요';
export const ENTRY_DRIFT_DETAIL = '고수 체결가보다 0.5% 넘게 움직여 진입하지 않았어요';
/** open/add 를 건너뛸 사유. 없으면 null */
export function entryGuardReason(eventCreatedAt: number, eventPrice: number, mark: number, now = Date.now(), maxAgeMs = ENTRY_MAX_AGE_MS, maxDrift = ENTRY_MAX_DRIFT): string | null {
  if (now - eventCreatedAt > maxAgeMs) return ENTRY_STALE_DETAIL;
  if (eventPrice > 0 && mark > 0 && Math.abs(mark - eventPrice) / eventPrice > maxDrift) return ENTRY_DRIFT_DETAIL;
  return null;
}

/** 진입·정리 수수료 추정 (명목의 0.05% × 2) — 손실 한도 판정의 미실현에 포함 */
export const roundTripFee = (contracts: number, contractSize: number, entry: number, mark: number): number => contracts * contractSize * (entry + mark) * TAKER_FEE;
