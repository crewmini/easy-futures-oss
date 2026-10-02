import type { AppState } from '@easy-futures/shared';
import { fmtKrw, fmtSigned, fmtUsdt } from '../lib/format';

export function WalletCard({ state }: { state: AppState }) {
  const w = state.wallet; const rate = state.settings.usdtKrw;
  const pnlCls = w.unrealized > 0 ? 'up' : w.unrealized < 0 ? 'down' : '';
  return (
    <div className="card">
      <h2>내 지갑 {state.mode === 'paper' && <span className="badge ok">연습 엔진 · 가짜 돈</span>}</h2>
      <div className="kv"><span className="k">쓸 수 있는 돈</span><span className="v">{fmtUsdt(w.available)} USDT<br /><span className="small muted">≈ {fmtKrw(w.available, rate)}</span></span></div>
      <div className="kv"><span className="k">걸어둔 돈</span><span className="v">{fmtUsdt(w.positionMargin)} USDT</span></div>
      <div className="kv"><span className="k">지금 팔면 손익</span><span className={`v ${pnlCls}`}>{fmtSigned(w.unrealized)} USDT<br /><span className="small">≈ {w.unrealized < 0 ? '-' : ''}{fmtKrw(Math.abs(w.unrealized), rate)}</span></span></div>
      <div className="kv"><span className="k">전체 자산</span><span className="v">{fmtUsdt(w.equity)} USDT</span></div>
    </div>
  );
}
