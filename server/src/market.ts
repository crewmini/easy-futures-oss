// 계약 상세(contract details) 캐시 + 폴백 상수. 격리환경 메모리에 10분 캐시.
import type { ContractInfo, Symbol } from '@easy-futures/shared';
import { SYMBOLS } from '@easy-futures/shared';
import { WooxClient } from './woox/client.js';
import { log } from './log.js';

/** 2026-09-07 실측 (/contract/public/details): 둘 다 contract_size 0.001, max_leverage 200. */
export const FALLBACK_CONTRACTS: Record<Symbol, ContractInfo> = {
  BTCUSDT: { symbol: 'BTCUSDT', contractSize: 0.001, pricePrecision: 0.1, volPrecision: 1, minVolume: 1, maxLeverage: 200 },
  ETHUSDT: { symbol: 'ETHUSDT', contractSize: 0.001, pricePrecision: 0.01, volPrecision: 1, minVolume: 1, maxLeverage: 200 },
  SOLUSDT: { symbol: 'SOLUSDT', contractSize: 1, pricePrecision: 0.01, volPrecision: 1, minVolume: 1, maxLeverage: 200 },  // 1계약 = 1 SOL (2026-09-08 실측)
};

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; contracts: Record<Symbol, ContractInfo> } | null = null;
let inflight: Promise<Record<Symbol, ContractInfo>> | null = null;

export async function getContracts(): Promise<Record<Symbol, ContractInfo>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.contracts;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await new WooxClient({ timeoutMs: 5000 }).getContractDetails();
      const out: Record<Symbol, ContractInfo> = { ...FALLBACK_CONTRACTS };
      for (const d of list) {
        if (!(SYMBOLS as string[]).includes(d.symbol)) continue;
        const s = d.symbol as Symbol;
        out[s] = {
          symbol: s,
          contractSize: Number(d.contract_size) || FALLBACK_CONTRACTS[s].contractSize,
          pricePrecision: Number(d.price_precision) || FALLBACK_CONTRACTS[s].pricePrecision,
          volPrecision: Number(d.vol_precision) || FALLBACK_CONTRACTS[s].volPrecision,
          minVolume: Number(d.min_volume) || FALLBACK_CONTRACTS[s].minVolume,
          maxLeverage: Number(d.max_leverage) || FALLBACK_CONTRACTS[s].maxLeverage,
        };
      }
      cache = { at: Date.now(), contracts: out };
      return out;
    } catch (e) {
      log.warn('contract details fetch failed, using fallback', { message: (e as Error).message });
      // 실패 시 1분만 폴백을 캐시해 재시도 폭주를 막는다.
      cache = { at: Date.now() - TTL_MS + 60_000, contracts: FALLBACK_CONTRACTS };
      return FALLBACK_CONTRACTS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
