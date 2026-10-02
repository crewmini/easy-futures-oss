import { useMemo, useState } from 'react';
import type { AppState, Direction, OpenOrderRequest, Symbol } from '@easy-futures/shared';
import { SYMBOL_LABEL, calcContracts, estimateLiquidation, priceAtRoi, roundToPrecision } from '@easy-futures/shared';
import { fmtCoin, fmtKrw, fmtPrice, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';
import { HoldButton } from './HoldButton';
import { api, ApiError } from '../lib/api';
import { withCopyLockConfirm } from '../lib/copyLock';
import { useToast } from './Toast';

const AMOUNTS = [500, 1000, 2000, 5000];
const LEVERAGES = [2, 5, 10, 20, 50, 100];
// 내 돈(증거금) 기준 %. 가격 변동률이 아님 — 레버리지로 나눠 가격을 구한다.
const SL_PCTS = [10, 20, 30, 50];
const TP_PCTS = [20, 50, 100, 200];

/** 첫 주문을 마쳤는지 (홈 화면 설치 안내는 그 뒤에만 보여준다) */
export const FIRST_ORDER_KEY = 'ef.firstOrderDone';
const newClientOrderId = () => `ef-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function OrderWizard({ state, symbol, offline = false, onClose, onDone }: { state: AppState; symbol: Symbol; offline?: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const label = SYMBOL_LABEL[symbol];
  const price = state.prices[symbol]?.mark ?? state.prices[symbol]?.last ?? 0; // 공정가(마크) 기준
  const c = state.contracts[symbol];
  const s = state.settings;
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const available = Math.floor(state.wallet.available * 100) / 100;
  const amountCap = Math.min(available, s.maxAmountUsdt); // 이번에 걸 수 있는 최대 (잔고와 1회 한도 중 작은 값)
  const amountPct = amount && amountCap > 0 ? Math.min(100, Math.round((amount / amountCap) * 100)) : 0;
  const insufficient = !!amount && amount > available;
  const maxLev = Math.min(s.maxLeverage, c.maxLeverage);
  const [leverage, setLeverage] = useState<number | null>(null);
  const [slPct, setSlPct] = useState<number | null>(null);
  const [tpPct, setTpPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [orderErr, setOrderErr] = useState<string | null>(null);
  // 응답이 늦어 주문이 들어갔는지 모를 때: 다시 누르면 두 번 들어갈 수 있으니 이 시트에서는 더 못 누르게 잠근다
  const [timedOut, setTimedOut] = useState(false);
  const [clientOrderId] = useState(newClientOrderId); // 시트를 열 때마다 새로
  const [result, setResult] = useState<{ entry: number | null; coin: number; sl: number; tp: number | null; adjusted: boolean } | null>(null);
  const existing = state.positions.find((p) => p.symbol === symbol);

  const calc = useMemo(() => {
    if (!direction || !amount || !leverage) return null;
    const contracts = calcContracts(amount, leverage, price, c);
    const coin = contracts * c.contractSize;
    const sl = slPct ? roundToPrecision(priceAtRoi(price, slPct, leverage, direction, 'sl'), c.pricePrecision) : null;
    const tp = tpPct ? roundToPrecision(priceAtRoi(price, tpPct, leverage, direction, 'tp'), c.pricePrecision) : null;
    const liq = roundToPrecision(estimateLiquidation(price, leverage, direction), c.pricePrecision);
    const margin = (coin * price) / leverage; // 계약 단위로 내림한 뒤 실제로 걸리는 내 돈
    // 손절가가 강제정리가를 넘어서면(=먼저 강제정리됨) 위험
    const slBeyondLiq = !!sl && (direction === 'long' ? sl <= liq * 1.001 : sl >= liq * 0.999);
    return { contracts, coin, sl, tp, liq, slBeyondLiq, notional: coin * price, margin, lossAtSl: slPct ? (margin * slPct) / 100 : 0, gainAtTp: tpPct ? (margin * tpPct) / 100 : 0 };
  }, [direction, amount, leverage, slPct, tpPct, price, c]);

  const steps = ['방향', '금액', '배율', '손절', '확인'];
  const canNext = [!!direction, !!amount && amount > 0 && !insufficient && amount <= s.maxAmountUsdt, !!leverage, !!slPct && !calc?.slBeyondLiq][step] ?? false;
  const next = () => setStep((x) => Math.min(4, x + 1));
  const back = () => (step === 0 ? onClose() : setStep((x) => x - 1));
  const dirWord = direction === 'long' ? '오른다' : '내린다';
  const goHome = () => { onDone(); onClose(); };

  const submit = async () => {
    if (!direction || !amount || !leverage || !calc?.sl) return;
    setBusy(true); setOrderErr(null);
    const req: OpenOrderRequest = { symbol, direction, amountUsdt: amount, leverage, stopLossPrice: calc.sl, takeProfitPrice: calc.tp, stopLossRoiPct: slPct, takeProfitRoiPct: tpPct };
    try {
      // 같은 종목에 고수 따라하기로 들어간 포지션이 있으면(화면이 알거나 서버 409) 확인 창 뒤 force 로. null = 취소
      const r = await withCopyLockConfirm((force) => api.open({ ...req, clientOrderId, ...(force ? { force: true } : {}) }), existing?.copy?.masterNickname);
      if (r == null) return;
      setResult({ entry: r.entryPrice, coin: r.coinAmount, sl: r.stopLossPrice ?? req.stopLossPrice, tp: r.takeProfitPrice ?? req.takeProfitPrice ?? null, adjusted: !!r.adjusted });
      try { localStorage.setItem(FIRST_ORDER_KEY, '1'); } catch { /* ignore */ }
      onDone();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '주문이 안 됐어요';
      if (e instanceof ApiError && e.code === 'TIMEOUT') { setTimedOut(true); setOrderErr(null); }
      else { setOrderErr(msg); toast(msg, 'err'); }
    }
    finally { setBusy(false); }
  };

  if (result) {
    return (
      <div className="sheet"><div className="inner">
        <div className="banner ok" style={{ fontSize: '1.2rem', marginTop: '2rem' }}>주문이 들어갔어요 ✅</div>
        <div className="card">
          <div className="summary">{label.name}이 <b className={`em ${direction === 'long' ? '' : 'down'}`}>{dirWord}</b>에 <b>{fmtUsdt(amount)} USDT</b>를 <b>{leverage}배</b>로 걸었어요.</div>
          <div className="kv"><span className="k">산 가격</span><span className="v">{result.entry ? `${fmtPrice(result.entry)} 달러` : '확인 중…'}</span></div>
          <div className="kv"><span className="k">물량</span><span className="v">{fmtCoin(result.coin, label.coin)}</span></div>
          <div className="kv"><span className="k">손절가</span><span className="v down">{fmtPrice(result.sl)} <span className="small muted">(내 돈의 -{slPct}%)</span></span></div>
          {result.tp && <div className="kv"><span className="k">익절가</span><span className="v up">{fmtPrice(result.tp)} <span className="small muted">(내 돈의 +{tpPct}%)</span></span></div>}
          {result.adjusted && <div className="hint">실제 산 가격에 맞춰 손절·익절가를 다시 맞췄어요.</div>}
        </div>
        <button className="btn primary" onClick={onClose}>내 상태 보러 가기</button>
      </div></div>
    );
  }

  return (
    <div className="sheet">
      <div className="inner">
        <div className="sheet-head">
          <button className="btn ghost" onClick={back}>← {step === 0 ? '닫기' : '뒤로'}</button>
          <h2 className="row" style={{ justifyContent: 'flex-start', gap: '0.4rem' }}><CoinLogo symbol={symbol} size={22} /> {label.name} 새로 걸기</h2>
        </div>
        <div className="step-dots">
          {steps.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}
          <span className="step-text" aria-live="polite">{step + 1}/{steps.length} {steps[step]}</span>
        </div>
        <div className="row small muted" style={{ justifyContent: 'center', marginBottom: '0.5rem' }}>지금 가격 {fmtPrice(price)} 달러 · 쓸 수 있는 돈 {fmtUsdt(state.wallet.available)} USDT</div>

        {existing && step === 0 && (
          <div className="banner warn">이미 {label.name}에 <b>{existing.direction === 'long' ? '오른다' : '내린다'}</b>로 걸어둔 것이 있어요. 같은 방향이면 물량이 합쳐지고, 반대 방향은 먼저 정리해야 해요.{existing.copy && <><br />👥 <b>{existing.copy.masterNickname} 고수 따라하기</b>로 들어간 포지션이에요. 직접 주문하면 고수를 따라가지 못하고 손절이 겹칠 수 있어요 — 주문 전에 한 번 더 물어봐요.</>}</div>
        )}

        {step === 0 && (<>
          <p className="question">{label.name} 가격이 어느 쪽으로 갈 것 같으세요?</p>
          <div className="grid2">
            <button className={`btn tall ${direction === 'long' ? 'up' : ''}`} onClick={() => { setDirection('long'); next(); }}>📈 오른다<span className="sub">오르면 이익</span></button>
            <button className={`btn tall ${direction === 'short' ? 'down' : ''}`} onClick={() => { setDirection('short'); next(); }}>📉 내린다<span className="sub">내리면 이익</span></button>
          </div>
        </>)}

        {step === 1 && (<>
          <p className="question">투자 금액을 정해 주세요</p>
          <div className="banner ok">투자할 수 있는 돈 <b>{fmtUsdt(available)} USDT</b> <span className="small">(≈ {fmtKrw(available, s.usdtKrw)})</span></div>
          <div className="grid2">
            {AMOUNTS.map((a) => (
              <button key={a} className={`btn tall ${amount === a ? 'selected' : ''}`} disabled={a > amountCap} onClick={() => setAmount(a)}>
                {fmtUsdt(a)} USDT<span className="sub">≈ {fmtKrw(a, s.usdtKrw)}</span>
              </button>
            ))}
          </div>
          {AMOUNTS.some((a) => a > s.maxAmountUsdt) && <div className="hint" style={{ marginTop: '0.4rem' }}>흐린 버튼은 설정의 1회 최대 금액({fmtUsdt(s.maxAmountUsdt)} USDT)을 넘어요.</div>}
          <div className="hint">또는 아래 막대를 밀어서 정하세요. 오른쪽 끝이 이번에 걸 수 있는 최대 <b>{fmtUsdt(amountCap)} USDT</b>예요.</div>
          <input type="range" className="slider" min={0} max={100} step={5} value={amountPct} aria-label="투자 비율"
            onChange={(e) => { const p = Number(e.target.value); setAmount(p === 0 ? null : Math.floor(amountCap * p) / 100); }} />
          <div className="row"><span className="badge ok">{amountPct}%</span><span className="big">{amount ? `${fmtUsdt(amount)} USDT` : '—'}</span></div>
          <div className="hint">직접 입력 (USDT)</div>
          <input className="num" inputMode="decimal" value={amount ?? ''} placeholder="예: 700"
            onChange={(e) => { const v = Number(e.target.value); setAmount(e.target.value === '' || !isFinite(v) ? null : v); }} />
          {insufficient && <div className="banner err">잔고가 부족해요. 투자할 수 있는 돈은 {fmtUsdt(available)} USDT예요. 금액을 다시 확인해 주세요.</div>}
          {!insufficient && !!amount && amount > s.maxAmountUsdt && <div className="banner warn">설정에서 정한 1회 최대 금액({fmtUsdt(s.maxAmountUsdt)} USDT)을 넘었어요. 설정에서 한도를 바꿀 수 있어요.</div>}
        </>)}

        {step === 2 && (<>
          <p className="question">레버리지(배율)를 정해 주세요</p>
          <div className="grid3">
            {LEVERAGES.filter((l) => l <= maxLev).map((l) => (
              <button key={l} className={`btn tall ${leverage === l ? 'selected' : ''} ${l >= 20 ? 'risky' : ''}`} onClick={() => setLeverage(l)}>
                {l}배<span className="sub">{l >= 20 ? `⚠️ 가격 ${(100 / l).toFixed(1)}%면 강제정리` : `1% 움직이면 ${l}%`}</span>
              </button>
            ))}
          </div>
          <div className="hint">더 세밀하게 정하려면 막대를 미세요 (2배 ~ {maxLev}배).</div>
          <input type="range" className="slider" min={2} max={maxLev} step={1} value={leverage ?? 2} aria-label="배율"
            onChange={(e) => setLeverage(Number(e.target.value))} />
          <div className="row"><span className="badge warn">{leverage ?? '—'}배</span><span className="small muted">가격이 1% 움직이면 내 돈의 {leverage ?? '—'}% 변동</span></div>
          <div className="hint">배율이 높을수록 이익도 손해도 {leverage ?? 'N'}배가 돼요. {leverage && leverage >= 20 ? '⚠️ 20배 이상은 가격이 조금만 반대로 가도 강제정리될 수 있어요.' : leverage && leverage >= 10 ? '⚠️ 10배 이상은 가격이 조금만 반대로 가도 돈을 잃기 쉬워요.' : ''}</div>
          {amount && leverage && (
            <div className="banner ok">내 돈 {fmtUsdt(amount)} USDT × {leverage}배 = <b>{fmtUsdt(amount * leverage)} USDT</b>어치 ({fmtCoin(calc?.coin ?? 0, label.coin)})</div>
          )}
          {calc && calc.contracts === 0 && <div className="banner err">금액이 너무 적어요. 최소 {fmtCoin(c.minVolume * c.contractSize, label.coin)}는 되어야 해요.</div>}
        </>)}

        {step === 3 && direction && leverage && (<>
          <p className="question">내 돈의 몇 %를 잃으면 자동으로 정리할까요? <span className="muted small">(손절)</span></p>
          <div className="hint" style={{ marginTop: 0, marginBottom: '0.6rem' }}>{leverage}배라서 가격이 조금만 움직여도 내 돈은 {leverage}배로 움직여요. 아래 %는 <b>내 돈 기준</b>이에요.</div>
          <div className="grid4">
            {SL_PCTS.map((p) => (
              <button key={p} className={`btn tall ${slPct === p ? 'selected' : ''}`} onClick={() => setSlPct(p)}>
                -{p}%<span className="sub">{fmtPrice(roundToPrecision(priceAtRoi(price, p, leverage, direction, 'sl'), c.pricePrecision))}</span>
              </button>
            ))}
          </div>
          {calc?.slBeyondLiq && (
            <div className="banner err">⚠️ 이 손절가는 강제정리가({fmtPrice(calc.liq)})와 같거나 그 너머예요. 손절이 먼저 작동하지 않아요. 배율을 낮추거나 손절 %를 줄여 주세요.</div>
          )}
          {slPct && amount && calc && !calc.slBeyondLiq && (
            <div className="banner warn">가격이 <b>{fmtPrice(calc.sl)} 달러</b>(지금보다 {(slPct / leverage).toFixed(1)}% {direction === 'long' ? '아래' : '위'})가 되면 자동 정리. 그때 손해는 약 <b>{fmtUsdt(calc.lossAtSl)} USDT</b> (내 돈의 {slPct}%)</div>
          )}
          <div className="divider" />
          <p className="question" style={{ fontSize: '1.1rem' }}>내 돈이 몇 % 불어나면 자동으로 정리할까요? <span className="muted small">(익절, 선택)</span></p>
          <div className="grid4">
            {TP_PCTS.map((p) => (
              <button key={p} className={`btn small ${tpPct === p ? 'selected' : ''}`} onClick={() => setTpPct(tpPct === p ? null : p)}>+{p}%</button>
            ))}
          </div>
          <div className="hint">{tpPct && calc ? `${fmtPrice(calc.tp)} 달러(지금보다 ${(tpPct / leverage).toFixed(1)}% ${direction === 'long' ? '위' : '아래'})가 되면 약 +${fmtUsdt(calc.gainAtTp)} USDT 이익 실현` : '선택 안 하면 직접 정리할 때까지 유지돼요'}</div>
        </>)}

        {step === 4 && direction && calc && (<>
          <p className="question">이대로 주문할까요?</p>
          <div className="card summary">
            <b>{label.name}</b>이 <b className={`em ${direction === 'long' ? '' : 'down'}`}>{dirWord}</b>에 <b>{fmtUsdt(amount)} USDT</b>(≈{fmtKrw(amount, s.usdtKrw)})를 <b>{leverage}배</b>로 겁니다.<br />
            지금 가격(약 {fmtPrice(price)} 달러)에 바로 삽니다. 물량은 {fmtCoin(calc.coin, label.coin)}({calc.contracts}계약)입니다.<br />
            {Math.abs(calc.margin - (amount ?? 0)) > 0.5 ? <>계약 단위로 맞추면 실제로 걸리는 돈은 <b>{fmtUsdt(calc.margin)} USDT</b>입니다.<br /></> : null}
            가격이 <b className="em down">{fmtPrice(calc.sl)} 달러</b>가 되면 자동으로 정리합니다 (손절, 내 돈의 {slPct}% ≈ -{fmtUsdt(calc.lossAtSl)} USDT).<br />
            {calc.tp ? <>가격이 <b className="em">{fmtPrice(calc.tp)} 달러</b>가 되면 이익을 실현합니다 (익절, 내 돈의 {tpPct}% ≈ +{fmtUsdt(calc.gainAtTp)} USDT).<br /></> : null}
            강제정리 가격은 약 <b style={{ color: 'var(--warn)' }}>{fmtPrice(calc.liq)} 달러</b>입니다.
          </div>
          {timedOut && (
            <div className="banner err" style={{ lineHeight: 1.5 }}>
              응답이 늦어요. 주문이 <b>들어갔을 수도</b> 있어요. 두 번 들어가지 않게 여기서는 더 누를 수 없어요 — "내 상태"에서 걸어둔 것이 있는지 확인한 뒤, 없으면 다시 새로 걸기를 눌러 주세요.
              <button className="btn primary" style={{ marginTop: '0.6rem' }} onClick={goHome}>내 상태 보러 가기</button>
            </div>
          )}
          {orderErr && <div className="banner err">주문이 들어가지 않았어요: {orderErr}</div>}
          {offline && <div className="banner err">연결이 끊겨 있어요. 연결이 돌아오면 다시 눌러 주세요.</div>}
          {state.mode === 'live' && <div className="banner err">⚠️ 실제 돈으로 주문됩니다.</div>}
          {state.mode === 'paper' && <div className="banner ok">관리자 연습 엔진: 가짜 돈으로 주문돼요.</div>}
        </>)}
      </div>

      <div className="bottom"><div className="inner">
        {step < 4 ? (
          <button className="btn primary" disabled={!canNext || (step === 2 && calc?.contracts === 0)} onClick={next}>다음 →</button>
        ) : timedOut ? (
          <button className="btn primary" onClick={goHome}>내 상태 보러 가기</button>
        ) : (
          <HoldButton label="길게 눌러서 주문하기" busy={busy} busyLabel="주문 보내는 중… 잠시만요" className={`btn ${direction === 'long' ? 'up' : 'down'}`} onConfirm={submit} disabled={offline || !calc?.sl || calc.contracts === 0 || calc.slBeyondLiq} />
        )}
      </div></div>
    </div>
  );
}
