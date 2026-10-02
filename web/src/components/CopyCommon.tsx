import { useEffect, useState } from 'react';
import type { CopyCloseReason, CopyEventKind, CopyExecution, CopyFollowSettings, CopyLeftoverReason, CopyPositionView, CopyStopReason, Direction } from '@easy-futures/shared';
import { COPY_LIMITS, SYMBOL_LABEL } from '@easy-futures/shared';
import { ApiError } from '../lib/api';
import { fmtPrice, fmtSigned, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';

/** 고수 따라하기 화면들이 같이 쓰는 조각: 오류 문구, 우리말 변환, 손익 글자, 설정 슬라이더, 포지션·실행 줄 */

export const NOT_READY = '고수 따라하기는 아직 준비 중이에요. 잠시 후 다시 열어 주세요.';
/** 서버 오류 → 사람 말. 스텁(501)이거나 라우트 자체가 없어 JSON code 없이 404 가 오면 "준비 중". 서버가 code 와 함께 보낸 404("그 고수를 찾을 수 없어요")는 그대로 보여준다 */
export function copyErrMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError) { if (e.status === 501 || (e.status === 404 && e.code == null)) return NOT_READY; return e.message || fallback; }
  return fallback;
}

export const dirWord = (d: Direction) => (d === 'long' ? '오른다' : '내린다');
export const KIND_WORD: Record<CopyEventKind, string> = { open: '진입', add: '추가 진입', reduce: '일부 정리', close: '정리', tpsl: '손절·익절 변경', leverage: '배율 변경' };
/** 이벤트 종류 배지 색: 진입/추가는 방향색, 정리는 주의색, 손절·익절/배율 변경은 확인색 — 글자가 항상 같이 붙는다 */
export const kindBadgeCls = (kind: CopyEventKind, direction: Direction) => (kind === 'open' || kind === 'add' ? (direction === 'long' ? 'up' : 'down') : kind === 'close' || kind === 'reduce' ? 'warn' : 'ok');
export const kindLabel = (kind: CopyEventKind, direction: Direction) => (kind === 'open' || kind === 'add' ? `${dirWord(direction)} ${KIND_WORD[kind]}` : KIND_WORD[kind]);
export const MIRROR_NOTE = '고수가 배율·손절·익절을 바꾸면 내 포지션에도 바로 똑같이 반영돼요.';
export const STOP_REASON: Record<CopyStopReason, string> = {
  user: '내가 직접 멈췄어요.',
  loss_limit: '손실 한도에 닿아 자동으로 멈추고 따라 들어간 것을 전부 정리했어요.',
  master_suspended: '고수가 중지돼 더 이상 따라가지 않아요.',
  no_api_key: '거래소 연결(API 키)이 없어져서 멈췄어요.',
  mode_switch: '거래 모드가 바뀌어 멈췄어요.',
  paper_switch: '거래 모드가 바뀌어 멈췄어요.',
  kyc_rejected: '신분증 확인이 취소돼 멈췄어요.',
  terms_outdated: '따라하기 특약이 바뀌어서 멈췄어요. 다시 읽고 동의하면 새로 따라갈 수 있어요.',
  admin: '담당자가 멈췄어요.',
  account_deleted: '계정이 삭제돼 멈췄어요.',
};
/** 정리하지 못한 포지션(leftovers) 사유 — 짧은 명사형 (한 줄 안에 종목·계약·배율과 같이 붙는다) */
export const LEFTOVER_REASON: Record<CopyLeftoverReason, string> = {
  user: '직접 멈춤',
  loss_limit: '손실 한도',
  loss_limit_partial: '손실 한도 정리 실패',
  master_suspended: '고수 중지',
  no_api_key: 'API 키 없음',
  mode_switch: '모드 변경',
  paper_switch: '모드 변경',
  kyc_rejected: '신분증 확인 취소',
  terms_outdated: '특약 변경',
  admin: '담당자 정지',
  account_deleted: '계정 삭제',
};
/** 고수 close 이벤트의 정리 사유 배지 글자. normal/null 은 배지 없음 */
export const closeReasonLabel = (r: CopyCloseReason | null | undefined): string | null => (r === 'liquidation' ? '⚡ 강제정리' : r === 'adl' ? 'ADL 자동감축' : null);
export function CloseReasonBadge({ reason }: { reason: CopyCloseReason | null | undefined }) {
  const label = closeReasonLabel(reason);
  // .badge.fail 은 '✕ ' 를 앞에 붙이므로 쓰지 않는다 — 같은 색(빨강 테두리)만 인라인으로
  return label ? <span className="badge" style={{ background: '#fff', color: 'var(--danger)', border: '1px solid var(--danger)', whiteSpace: 'normal' }}>{label}</span> : null;
}
/** 체결 차이(슬리피지): 양수 = 팔로워에게 불리. "+0.12% 불리" / "-0.05% 유리" / "0.00% 같음" — 색이 아니라 글자로 뜻을 전한다 */
export const fmtSlip = (pct: number) => `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(2)}% ${pct > 0 ? '불리' : pct < 0 ? '유리' : '같음'}`;
export const fmtWhen = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const pnlCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** 손익: 색 + 글자(이익/손실) 병기 — 색만으로 뜻을 전하지 않는다 */
export function PnlWord({ v, unit = 'USDT', word = true }: { v: number; unit?: string; word?: boolean }) {
  return <span className={pnlCls(v)}>{fmtSigned(v)} {unit}{word && <span className="small"> ({v > 0 ? '이익' : v < 0 ? '손실' : '변동 없음'})</span>}</span>;
}

export function ExecBadge({ status }: { status: CopyExecution['status'] }) {
  return <span className={`badge ${status === 'ok' ? 'ok' : status === 'failed' ? 'fail' : status === 'pending' ? 'neutral' : 'warn'}`}>{status === 'ok' ? '완료' : status === 'failed' ? '실패' : status === 'pending' ? '실행 중' : '건너뜀'}</span>;
}

/** 따라 들어간 포지션 한 줄: 종목·방향·계약·평단·지금 손익 */
export function CopyPositionRows({ positions }: { positions: CopyPositionView[] }) {
  if (positions.length === 0) return <div className="empty" style={{ padding: '0.5rem' }}>지금 따라 들어간 포지션이 없어요.</div>;
  return (
    <div>
      {positions.map((p) => (
        <div key={p.symbol} className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
          <CoinLogo symbol={p.symbol} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hist-title"><span>{SYMBOL_LABEL[p.symbol].name}</span><span className={`badge ${p.direction === 'long' ? 'up' : 'down'}`}>{dirWord(p.direction)}</span></div>
            <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{p.contracts}계약 · 평단 {fmtPrice(p.entryPrice)} 달러 · {p.leverage}배</div>
            {(p.stopLossPrice != null || p.takeProfitPrice != null) && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>손절 {p.stopLossPrice != null ? `${fmtPrice(p.stopLossPrice)} 달러` : '없음'} · 익절 {p.takeProfitPrice != null ? `${fmtPrice(p.takeProfitPrice)} 달러` : '없음'}</div>}
          </div>
          <div style={{ flex: '0 1 auto', maxWidth: '40%', textAlign: 'right', fontWeight: 900, overflowWrap: 'anywhere' }}><PnlWord v={p.unrealizedPnl} /></div>
        </div>
      ))}
    </div>
  );
}

/** 실행 기록 한 줄 (내 기록·고수 대시보드 공용). who 가 있으면 아이디를 앞에 */
export function ExecRow({ e, who }: { e: CopyExecution; who?: string }) {
  const ev = e.event;
  return (
    <div className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
      {ev ? <CoinLogo symbol={ev.symbol} size={28} /> : <span style={{ width: 28, flex: 'none' }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="hist-title">
          {who && <span style={{ overflowWrap: 'anywhere' }}>{who}</span>}
          <span>{ev ? SYMBOL_LABEL[ev.symbol].name : e.eventId}</span>
          {ev && <span className={`badge ${kindBadgeCls(ev.kind, ev.direction)}`}>{kindLabel(ev.kind, ev.direction)}</span>}
          {ev?.kind === 'close' && <CloseReasonBadge reason={ev.closeReason} />}
          <span className={`badge ${e.mode === 'live' ? 'live' : 'neutral'}`}>{e.mode === 'live' ? '실거래' : '연습 엔진'}</span>
        </div>
        {e.detail && <div style={{ fontWeight: 800, fontSize: '0.9rem', overflowWrap: 'anywhere' }}>{e.detail}</div>}
        <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{fmtWhen(e.createdAt)}{e.contracts ? ` · ${e.contracts}계약` : ''}{ev?.price ? ` · ${fmtPrice(ev.price)} 달러` : ''}</div>
        {/* 내 체결가와 고수 이벤트 가격의 차이 (2026-09-22) */}
        {e.slippagePct != null && <div className="small" style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{e.fillPrice != null ? `체결 ${fmtPrice(e.fillPrice)} · ` : ''}고수와 차이 {fmtSlip(e.slippagePct)}</div>}
      </div>
      <div style={{ flex: '0 1 auto', maxWidth: '40%', textAlign: 'right', overflowWrap: 'anywhere' }}>
        <ExecBadge status={e.status} />
        {e.pnl != null && <div style={{ fontWeight: 900, marginTop: '0.2rem' }}><PnlWord v={e.pnl} word={false} /></div>}
      </div>
    </div>
  );
}

const AMOUNTS = [50, 100, 300, 500, 1000];
const [LL_MIN, LL_MAX] = COPY_LIMITS.lossLimitPct;
const [LEV_MIN, LEV_MAX] = COPY_LIMITS.maxLeverage;
const [SL_MIN, SL_MAX] = COPY_LIMITS.slRoi;
export const clampSettings = (s: CopyFollowSettings): CopyFollowSettings => ({
  copyAmount: Math.min(COPY_LIMITS.copyAmountMax, Math.max(COPY_LIMITS.copyAmountMin, Math.round(s.copyAmount))),
  lossLimitPct: Math.min(LL_MAX, Math.max(LL_MIN, Math.round(s.lossLimitPct))),
  maxLeverage: Math.min(LEV_MAX, Math.max(LEV_MIN, Math.round(s.maxLeverage))),
  slRoi: Math.min(SL_MAX, Math.max(SL_MIN, Math.round(s.slRoi))),
});

/**
 * 따라하기 설정 고르기: 따라갈 돈(숫자칸 + 프리셋 + 막대) · 여기까지 잃으면 멈추기 · 최대 배율 · 손절.
 * available = 지금 쓸 수 있는 돈 (막대 최대치 = min(available, 5000)).
 */
export function FollowSettingsPicker({ draft, setDraft, available }: { draft: CopyFollowSettings; setDraft: (d: CopyFollowSettings) => void; available: number }) {
  const sliderMax = Math.max(COPY_LIMITS.copyAmountMin, Math.min(Math.floor(available), COPY_LIMITS.copyAmountMax));   // 쓸 수 있는 돈 전액까지
  const sliderStep = sliderMax >= 50_000 ? 100 : sliderMax >= 5_000 ? 50 : 10;
  const [fullArmed, setFullArmed] = useState(false);   // '완전 따라가기' 경고 펼침
  const [amountText, setAmountText] = useState(String(draft.copyAmount));
  // 프리셋·막대로 바뀐 값은 숫자칸에도 반영 (직접 치는 중에는 그대로)
  useEffect(() => { if (Number(amountText) !== draft.copyAmount) setAmountText(String(draft.copyAmount)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [draft.copyAmount]);
  const setAmount = (n: number) => setDraft({ ...draft, copyAmount: n });
  const onType = (t: string) => { setAmountText(t); const n = Number(t.replace(/[^0-9.]/g, '')); if (isFinite(n) && n > 0) setAmount(Math.round(n)); };
  const tooLow = draft.copyAmount < COPY_LIMITS.copyAmountMin;
  const overAvail = draft.copyAmount > available;
  const lossUsdt = (draft.copyAmount * draft.lossLimitPct) / 100;
  const fullAmount = Math.max(COPY_LIMITS.copyAmountMin, Math.floor(available));
  const isFull = draft.copyAmount >= fullAmount && draft.lossLimitPct === LL_MAX && draft.maxLeverage === LEV_MAX && draft.slRoi === SL_MAX;
  const applyFull = () => { setDraft({ copyAmount: fullAmount, lossLimitPct: LL_MAX, maxLeverage: LEV_MAX, slRoi: SL_MAX }); setFullArmed(false); };
  return (
    <div className="stack">
      <div className="card" style={{ borderColor: isFull ? 'var(--danger)' : undefined }}>
        <div style={{ fontWeight: 900 }}>🔥 완전 따라가기 {isFull && <span className="badge down">적용됨</span>}</div>
        <div className="small muted" style={{ marginTop: '0.2rem' }}>쓸 수 있는 돈 전액({fmtUsdt(fullAmount)} USDT)을 따라갈 돈으로 하고, 손실 한도 {LL_MAX}% · 최대 배율 {LEV_MAX}배 · 손절 {SL_MAX}%로 한 번에 맞춰요. 고수의 배율·손절을 최대한 그대로 따라가는 설정이에요.</div>
        {!fullArmed && !isFull && <button className="btn danger" style={{ marginTop: '0.4rem' }} onClick={() => setFullArmed(true)}>완전 따라가기로 맞추기</button>}
        {fullArmed && (
          <div className="banner warn" style={{ marginTop: '0.4rem' }}>
            <div style={{ fontWeight: 900 }}>⚠️ 정말 전액으로 따라갈까요?</div>
            <div className="small" style={{ marginTop: '0.2rem' }}>
              • 고수가 크게 잃으면 내 돈 <b>{fmtUsdt(fullAmount)} USDT의 {LL_MAX}%</b>({fmtUsdt((fullAmount * LL_MAX) / 100)} USDT)까지 잃은 뒤에야 자동으로 멈춰요. 급변 때는 그보다 더 잃을 수도 있어요.<br />
              • 배율 {LEV_MAX}배는 가격이 {(100 / LEV_MAX).toFixed(1)}%만 반대로 가도 강제정리될 수 있어요.<br />
              • 고수가 손절 없이 진입하면 내 손절은 -{SL_MAX}%로 붙어요. 사실상 손절이 거의 없는 것과 같아요.<br />
              • 직접 거래에 쓸 돈이 남지 않아요.
            </div>
            <div className="grid2" style={{ marginTop: '0.4rem' }}>
              <button className="btn danger" onClick={applyFull}>네, 전액으로 맞춰요</button>
              <button className="btn ghost" onClick={() => setFullArmed(false)}>아니요</button>
            </div>
          </div>
        )}
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>따라갈 돈 (USDT) — 고수가 자기 돈의 몇 %를 쓰면, 이 돈의 같은 %만큼 따라 들어가요.</div>
        <input className="num" inputMode="decimal" aria-label="따라갈 돈" value={amountText} onChange={(e) => onType(e.target.value)} onBlur={() => setAmountText(String(draft.copyAmount))} />
        {/* 쓸 수 있는 돈을 넘는 프리셋은 회색으로 (서버가 거절하므로 고를 수 없게) */}
        <div className="grid3" style={{ marginTop: '0.4rem' }}>{AMOUNTS.map((a) => <button key={a} className={`btn small ${draft.copyAmount === a ? 'selected' : ''}`} disabled={a > available} aria-label={a > available ? `${a} USDT — 쓸 수 있는 돈보다 많아요` : undefined} onClick={() => setAmount(a)}>{a}</button>)}</div>
        <input type="range" className="slider" min={COPY_LIMITS.copyAmountMin} max={sliderMax} step={sliderStep} value={Math.min(sliderMax, draft.copyAmount)} aria-label="따라갈 돈 막대" onChange={(e) => setAmount(Number(e.target.value))} />
        <div className="row"><span className="badge warn">{fmtUsdt(draft.copyAmount)} USDT</span><span className="small muted">쓸 수 있는 돈 {fmtUsdt(available)} USDT</span></div>
        {tooLow && <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.2rem' }}>최소 {COPY_LIMITS.copyAmountMin} USDT부터 따라갈 수 있어요.</div>}
        {!tooLow && overAvail && <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.2rem' }}>⚠️ 쓸 수 있는 돈({fmtUsdt(available)} USDT)보다 많아요 — {fmtUsdt(Math.floor(available))} USDT 이하로 줄여 주세요.</div>}
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>여기까지 잃으면 멈추기 ({LL_MIN}~{LL_MAX}%)</div>
        <input type="range" className="slider" min={LL_MIN} max={LL_MAX} step={5} value={draft.lossLimitPct} aria-label="손실 한도" onChange={(e) => setDraft({ ...draft, lossLimitPct: Number(e.target.value) })} />
        <div className="row"><span className="badge down">-{draft.lossLimitPct}%</span><span className="small muted">≈ {fmtUsdt(lossUsdt)} USDT</span></div>
        <div className="hint" style={{ marginTop: '0.2rem' }}>따라갈 돈의 {draft.lossLimitPct}%를 잃으면 자동으로 멈추고 전부 정리해요. (급변 때는 그보다 더 잃을 수도 있어요)</div>
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>최대 배율 ({LEV_MIN}~{LEV_MAX}배)</div>
        <input type="range" className="slider" min={LEV_MIN} max={LEV_MAX} step={1} value={draft.maxLeverage} aria-label="최대 배율" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value) })} />
        <div className="row"><span className="badge warn">{draft.maxLeverage}배</span><span className="small muted">가격이 1% 움직이면 내 돈의 최대 {draft.maxLeverage}% 변동</span></div>
        <div className="hint" style={{ marginTop: '0.2rem' }}>고수가 더 높은 배율을 써도 이 이상은 안 써요.</div>
        {draft.maxLeverage >= 20 && <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.2rem' }}>⚠️ 20배 이상은 가격이 {(100 / draft.maxLeverage).toFixed(1)}%만 반대로 가도 강제정리될 수 있어요.</div>}
        {draft.maxLeverage >= 10 && draft.maxLeverage < 20 && <div className="hint" style={{ marginTop: '0.2rem' }}>⚠️ 10배 이상은 가격이 조금만 반대로 가도 돈을 잃기 쉬워요.</div>}
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>손절 (내 돈 기준, {SL_MIN}~{SL_MAX}%)</div>
        <input type="range" className="slider" min={SL_MIN} max={SL_MAX} step={5} value={draft.slRoi} aria-label="손절" onChange={(e) => setDraft({ ...draft, slRoi: Number(e.target.value) })} />
        <div className="row"><span className="badge down">-{draft.slRoi}%</span><span className="small muted">고수가 손절 없이 진입할 때만 내 돈 기준 -{draft.slRoi}%에 손절이 붙어요. 고수 손절이 있으면 그 값을 그대로 따라요</span></div>
      </div>
    </div>
  );
}
