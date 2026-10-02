import { useEffect, useRef, useState } from 'react';
import type { AppState, Kline, Symbol } from '@easy-futures/shared';
import { SYMBOLS, SYMBOL_LABEL } from '@easy-futures/shared';
import { fmtPct, fmtPrice } from '../lib/format';
import { api } from '../lib/api';
import { CoinLogo } from './CoinLogo';

export function SymbolToggle({ value, onChange }: { value: Symbol; onChange: (s: Symbol) => void }) {
  return (
    <div className={`seg ${SYMBOLS.length > 2 ? 'seg3' : ''}`} role="tablist" aria-label="종목 선택">
      {SYMBOLS.map((s) => (
        <button key={s} role="tab" aria-selected={value === s} className={`btn ${value === s ? 'selected' : ''}`} onClick={() => onChange(s)}>
          <CoinLogo symbol={s} size={SYMBOLS.length > 2 ? 22 : 28} /> {SYMBOL_LABEL[s].name}
        </button>
      ))}
    </div>
  );
}

export function PriceHeader({ state, symbol }: { state: AppState; symbol: Symbol }) {
  const p = state.prices[symbol];
  const chg = p?.change24hPct;
  const dir = chg == null ? '' : chg > 0 ? 'up' : chg < 0 ? 'down' : '';
  const [kl, setKl] = useState<Kline[]>([]);
  // 직전 가격과 비교해 오르면 빨강, 내리면 파랑으로 잠깐 강조
  const prev = useRef<number | undefined>(undefined);
  const cur = p?.mark ?? p?.last;
  const tick = prev.current != null && cur != null && cur !== prev.current ? (cur > prev.current ? 'tick-up' : 'tick-down') : '';
  useEffect(() => { prev.current = cur; }, [cur]);
  useEffect(() => {
    let alive = true;
    const load = () => api.klines(symbol, 15, 96).then((k) => { if (alive) setKl(k); }).catch(() => {});
    load();
    const id = window.setInterval(load, 60000);
    return () => { alive = false; window.clearInterval(id); };
  }, [symbol]);

  return (
    <div className="card">
      <h2 className="row" style={{ justifyContent: 'flex-start', gap: '0.4rem' }}><CoinLogo symbol={symbol} size={22} /> {SYMBOL_LABEL[symbol].name} 지금 가격</h2>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div key={cur} className={`huge ${dir} ${tick}`}>{fmtPrice(cur)} <span className="small muted" style={{ fontWeight: 700 }}>달러</span></div>
      </div>
      <div className="row" style={{ marginTop: '0.3rem' }}>
        <span className={`badge ${dir || 'ok'}`}>
          {chg == null ? '어제와 비교 중…' : chg > 0 ? `▲ 어제보다 ${fmtPct(chg)} 올랐어요` : chg < 0 ? `▼ 어제보다 ${Math.abs(chg).toFixed(1)}% 내렸어요` : '어제와 같아요'}
        </span>
        {!state.connected && <span className="badge warn">시세 지연</span>}
      </div>
      <Sparkline data={kl} dir={dir} />
      <div className="small muted">최근 24시간 흐름</div>
    </div>
  );
}

function Sparkline({ data, dir }: { data: Kline[]; dir: string }) {
  if (data.length < 2) return <svg className="spark" viewBox="0 0 100 30" />;
  const cs = data.map((k) => k.c);
  const min = Math.min(...cs), max = Math.max(...cs);
  const span = max - min || 1;
  const pts = cs.map((c, i) => `${(i / (cs.length - 1)) * 100},${28 - ((c - min) / span) * 26}`).join(' ');
  const color = dir === 'down' ? 'var(--down)' : 'var(--up)';
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
