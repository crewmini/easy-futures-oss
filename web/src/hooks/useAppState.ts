import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Price, Symbol } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { subscribeTicker } from '../lib/ticker';

const POLL_MS = 4000;   // 거래소 키별 한도(포지션 조회 6회/2초)를 카피 실행과 나눠 쓰므로 3초 → 4초 (2026-10-01)
const SLOW_POLL_MS = 12000; // 서버/거래소 오류 뒤에는 천천히 (429 악화 방지)

/**
 * offline: 인터넷/서버에 닿지 못함 (ApiError.status === 0) → 주문 버튼을 잠근다.
 * error: 마지막 실패의 안내문. 서버가 답은 했지만 오류(status > 0)면 offline 은 false 이고 이 문구만 보여준다.
 */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const busy = useRef(false);
  const slow = useRef(false);
  const lastPoll = useRef(0);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const s = await api.state();
      setState((prev) => mergeLivePrices(s, prev));
      setError(null);
      setOffline(false);
      setUnauthorized(false);
      slow.current = false;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setUnauthorized(true); setOffline(false); return; }
      slow.current = true;
      const network = !(e instanceof ApiError) || e.status === 0;
      setOffline(network);
      setError(e instanceof ApiError ? e.message : '서버 연결 오류');
    } finally { busy.current = false; }
  }, []);

  useEffect(() => {
    void refresh();
    // 화면이 보일 때만 폴링 (300명 동시 사용 시 서버·거래소 호출 절감)
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const gap = slow.current ? SLOW_POLL_MS : POLL_MS;
      if (Date.now() - lastPoll.current < gap - 100) return;
      lastPoll.current = Date.now();
      void refresh();
    }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  // 공개 WS 시세를 즉시 반영 (걸어둔 것의 손익도 함께 재계산)
  useEffect(() => subscribeTicker((symbol, price) => {
    setState((prev) => (prev ? applyPrice(prev, symbol, price) : prev));
  }), []);

  return { state, error, offline, unauthorized, refresh };
}

function mergeLivePrices(s: AppState, prev: AppState | null): AppState {
  if (!prev) return s;
  let out = s;
  for (const sym of Object.keys(prev.prices) as Symbol[]) {
    const p = prev.prices[sym];
    if (p && p.updatedAt > (s.prices[sym]?.updatedAt ?? 0)) out = applyPrice(out, sym, p);
  }
  return out;
}

function applyPrice(s: AppState, symbol: Symbol, price: Price): AppState {
  const positions = s.positions.map((pos) => {
    if (pos.symbol !== symbol) return pos;
    const diff = pos.direction === 'long' ? price.mark - pos.entryPrice : pos.entryPrice - price.mark;
    const pnl = diff * pos.coinAmount;
    return { ...pos, markPrice: price.mark, unrealizedPnl: pnl, unrealizedPct: pos.marginUsdt > 0 ? (pnl / pos.marginUsdt) * 100 : 0 };
  });
  const unrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return { ...s, prices: { ...s.prices, [symbol]: price }, positions, wallet: { ...s.wallet, unrealized, equity: s.wallet.available + s.wallet.positionMargin + unrealized } };
}
