import { useState } from 'react';
import type { AppState, Position, Symbol } from '@easy-futures/shared';
import { SYMBOL_LABEL, priceAtRoi, roundToPrecision } from '@easy-futures/shared';
import { fmtCoin, fmtKrw, fmtPct, fmtPrice, fmtSigned, fmtUsdt } from '../lib/format';
import { PriceLadder } from './PriceLadder';
import { HoldButton } from './HoldButton';
import { api, ApiError } from '../lib/api';
import { withCopyLockConfirm } from '../lib/copyLock';
import { useToast } from './Toast';

export const OFFLINE_TEXT = '연결이 끊겨 있어요. 연결이 돌아오면 다시 눌러 주세요.';

export function PositionCard({ state, symbol, offline = false, onChanged }: { state: AppState; symbol: Symbol; offline?: boolean; onChanged: () => void }) {
  const pos = state.positions.find((p) => p.symbol === symbol);
  const toast = useToast();
  const [edit, setEdit] = useState<null | 'sl' | 'tp'>(null);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = SYMBOL_LABEL[symbol];

  if (!pos) {
    return (
      <div className="card">
        <h2>내 상태</h2>
        <div className="empty">지금 {label.name}에는<br />아무것도 걸어두지 않았어요.</div>
      </div>
    );
  }

  const isLong = pos.direction === 'long';
  const pnlCls = pos.unrealizedPnl > 0 ? 'up' : pos.unrealizedPnl < 0 ? 'down' : '';
  const rate = state.settings.usdtKrw;

  // 고수 따라하기로 들어간 포지션이면 확인 창을 거쳐 force 로 (lib/copyLock.ts). null = 취소
  const doClose = async () => {
    setBusy(true);
    try {
      const r = await withCopyLockConfirm((force) => api.close(symbol, force), pos.copy?.masterNickname);
      if (r == null) return;
      toast(`${label.name}에 걸어둔 것을 모두 정리했어요 ✅`); setClosing(false); onChanged();
    }
    catch (e) { toast(e instanceof ApiError ? e.message : '정리하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card pos-card">
      <h2>내 상태</h2>
      <div className="big" style={{ marginBottom: '0.3rem' }}>
        {label.name}이 <span className={isLong ? 'up' : 'down'}>{isLong ? '오른다' : '내린다'}</span>에 걸었어요
        <span className="badge warn" style={{ marginLeft: '0.4rem' }}>{pos.leverage}배</span>
        {pos.copy && <span className="badge copy" style={{ marginLeft: '0.4rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>👥 고수 따라하기 ({pos.copy.masterNickname})</span>}
      </div>
      {pos.copy && <div className="hint" style={{ marginTop: 0, marginBottom: '0.3rem' }}>{pos.copy.masterNickname} 고수를 따라 들어간 포지션이에요. 직접 정리하거나 손절을 바꾸면 고수를 따라가지 못해요 — 누르면 한 번 더 물어봐요.</div>}
      <div className={`huge ${pnlCls}`} style={{ fontSize: '2rem' }}>
        <span key={Math.round(pos.unrealizedPnl * 10)} className="pnl-pop">{fmtSigned(pos.unrealizedPnl)}</span> <span className="small" style={{ fontWeight: 700 }}>USDT</span>
      </div>
      <div className={`${pnlCls}`} style={{ fontWeight: 800 }}>
        지금 팔면 {pos.unrealizedPnl >= 0 ? '이익' : '손해'} {fmtKrw(Math.abs(pos.unrealizedPnl), rate)} ({fmtPct(pos.unrealizedPct)})
      </div>

      <PriceLadder pos={pos} />

      <div className="kv"><span className="k">걸어둔 돈</span><span className="v">{fmtUsdt(pos.marginUsdt)} USDT</span></div>
      <div className="kv"><span className="k">물량</span><span className="v">{fmtCoin(pos.coinAmount, label.coin)} <span className="small muted">({pos.contracts}계약)</span></span></div>
      <div className="kv"><span className="k">손절가</span><span className="v down">{pos.stopLossPrice ? fmtPrice(pos.stopLossPrice) : '없음 ⚠️'}</span></div>
      <div className="kv"><span className="k">익절가</span><span className="v up">{pos.takeProfitPrice ? fmtPrice(pos.takeProfitPrice) : '없음'}</span></div>
      <div className="kv"><span className="k">강제정리가</span><span className="v" style={{ color: 'var(--warn)' }}>{fmtPrice(pos.liquidationPrice)}</span></div>

      {offline && <div className="banner err" style={{ marginTop: '0.7rem', marginBottom: 0 }}>{OFFLINE_TEXT}</div>}
      <div className="grid2" style={{ marginTop: '0.7rem' }}>
        <button className="btn" disabled={offline} onClick={() => setEdit('sl')}>손절가 바꾸기</button>
        <button className="btn" disabled={offline} onClick={() => setEdit('tp')}>익절가 {pos.takeProfitPrice ? '바꾸기' : '걸기'}</button>
      </div>
      <div style={{ marginTop: '0.6rem' }}>
        {closing ? (
          <div className="stack">
            <div className="banner warn">정말 {label.name}에 걸어둔 것을 <b>전부</b> 지금 가격에 정리할까요?</div>
            <HoldButton label="길게 눌러서 전부 정리" busy={busy} busyLabel="정리하는 중… 잠시만요" className="btn danger" disabled={offline} onConfirm={doClose} />
            <button className="btn ghost" onClick={() => setClosing(false)}>아니요, 그대로 둘게요</button>
          </div>
        ) : (
          <button className="btn danger" disabled={offline} onClick={() => setClosing(true)}>전부 정리하기</button>
        )}
      </div>

      {edit && <TpSlSheet kind={edit} pos={pos} state={state} onClose={() => setEdit(null)} onChanged={onChanged} />}
    </div>
  );
}

function TpSlSheet({ kind, pos, state, onClose, onChanged }: { kind: 'sl' | 'tp'; pos: Position; state: AppState; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const c = state.contracts[pos.symbol];
  const isSl = kind === 'sl';
  const cur = isSl ? pos.stopLossPrice : pos.takeProfitPrice;
  const [price, setPrice] = useState<number | null>(cur ?? null);
  const [busy, setBusy] = useState(false);
  const lev = pos.leverage > 0 ? pos.leverage : 1;
  const pcts = isSl ? [10, 20, 30, 50] : [20, 50, 100, 200]; // 내 돈 기준 %
  const pick = (pct: number) => setPrice(roundToPrecision(priceAtRoi(pos.entryPrice, pct, lev, pos.direction, kind), c.pricePrecision));
  // 이미 지금 가격을 지나쳐 버린 프리셋은 거래소가 거절하므로 잠근다
  const passed = (p: number) => {
    const v = priceAtRoi(pos.entryPrice, p, lev, pos.direction, kind);
    const mustBeBelow = (pos.direction === 'long') === isSl; // 롱 손절·숏 익절은 지금 가격 아래여야
    return mustBeBelow ? v >= pos.markPrice : v <= pos.markPrice;
  };

  const dirWord = pos.direction === 'long' ? (isSl ? '내려가면' : '올라가면') : (isSl ? '올라가면' : '내려가면');
  const save = async (val: number | null) => {
    setBusy(true);
    try {
      const r = await withCopyLockConfirm((force) => api.tpsl({ symbol: pos.symbol, ...(isSl ? { stopLossPrice: val } : { takeProfitPrice: val }), ...(force ? { force: true } : {}) }), pos.copy?.masterNickname);
      if (r == null) return;   // 고수 따라하기 포지션 — 확인 창에서 취소
      toast(val ? `${isSl ? '손절가' : '익절가'}를 ${fmtPrice(val)} 달러로 정했어요 ✅` : `${isSl ? '손절' : '익절'}을 없앴어요`);
      onChanged(); onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : '바꾸지 못했어요', 'err'); }
    finally { setBusy(false); }
  };
  const pctNow = price ? Math.abs((price - pos.entryPrice) / pos.entryPrice) * 100 : null;

  return (
    <div className="sheet">
      <div className="inner">
        {/* 제목은 카드의 버튼 글자와 똑같이 (손절가 바꾸기 / 익절가 걸기·바꾸기) */}
        <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>{isSl ? '손절가 바꾸기' : cur ? '익절가 바꾸기' : '익절가 걸기'}</h2></div>
        <p className="question">내 돈의 몇 %{isSl ? '를 잃으면' : '가 불어나면'} 자동으로 정리할까요?</p>
        <div className="hint">산 가격(평단) {fmtPrice(pos.entryPrice)} 달러 · {lev}배 기준. 가격이 {dirWord} 정리돼요. 지금 가격 {fmtPrice(pos.markPrice)} (내 돈 기준 {pos.unrealizedPct >= 0 ? '+' : ''}{pos.unrealizedPct.toFixed(1)}%)</div>
        <div className="grid4" style={{ margin: '0.6rem 0' }}>
          {pcts.map((p) => (
            <button key={p} className={`btn tall ${pctNow != null && Math.abs(pctNow * lev - p) < 0.5 ? 'selected' : ''}`} disabled={passed(p)} onClick={() => pick(p)}>
              {isSl ? '-' : '+'}{p}%<span className="sub">{passed(p) ? '이미 지나갔어요' : fmtPrice(roundToPrecision(priceAtRoi(pos.entryPrice, p, lev, pos.direction, kind), c.pricePrecision))}</span>
            </button>
          ))}
        </div>
        <div className="hint">직접 입력 (달러)</div>
        <input className="num" inputMode="decimal" value={price ?? ''} onChange={(e) => setPrice(e.target.value === '' ? null : Number(e.target.value))} placeholder={`예: ${fmtPrice(Math.round(pos.entryPrice))}`} />
        {price != null && pctNow != null && (
          <div className="banner ok" style={{ marginTop: '0.6rem' }}>
            {fmtPrice(price)} 달러 → 산 가격보다 {pctNow.toFixed(1)}% {price > pos.entryPrice ? '높은' : '낮은'} 가격. 내 돈 기준 {((price > pos.entryPrice) === (pos.direction === 'long') ? '+' : '-')}{(pctNow * lev).toFixed(0)}% 에서 자동 정리
          </div>
        )}
        <div className="stack" style={{ marginTop: '0.8rem' }}>
          <button className="btn primary" disabled={busy || !price} onClick={() => save(price)}>이 가격으로 정하기</button>
          {!isSl && cur && <button className="btn ghost" disabled={busy} onClick={() => save(null)}>익절 없애기</button>}
        </div>
      </div>
    </div>
  );
}
