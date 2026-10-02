import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CopyDashboardResponse, CopyEvent, CopyExecution, CopyMasterHide } from '@easy-futures/shared';
import { SYMBOL_LABEL } from '@easy-futures/shared';
import { api } from '../lib/api';
import { fmtPct, fmtPrice, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';
import { OFFLINE_TEXT } from './PositionCard';
import { useToast } from './Toast';
import { CloseReasonBadge, CopyPositionRows, ExecBadge, ExecRow, PnlWord, copyErrMsg, fmtClock, fmtSlip, fmtWhen, kindBadgeCls, kindLabel, pnlCls } from './CopyCommon';

/** 고수의 "내 팔로워" 대시보드: 3초 폴링 (오프라인·화면 숨김이면 쉼). 거래소 호출 없이 장부+시세만 보여준다. */
export function CopyDashboard({ offline }: { offline: boolean }) {
  const [d, setD] = useState<CopyDashboardResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; rows: (CopyExecution & { loginId: string })[] | null; err?: string } | null>(null);
  const [hideLocal, setHideLocal] = useState<CopyMasterHide | null>(null);   // 저장 직후 값 (3초 폴링이 돌아오기 전에도 화면이 바로 바뀌게)
  const offlineRef = useRef(offline); offlineRef.current = offline;
  const load = useCallback(() => api.copyDashboard().then((r) => { setD(r); setErr(null); }).catch((e) => setErr(copyErrMsg(e, '팔로워 정보를 불러오지 못했어요'))), []);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => { if (!offlineRef.current && document.visibilityState === 'visible') void load(); }, 3000);
    return () => window.clearInterval(id);
  }, [load]);
  const toggle = async (ev: CopyEvent) => {
    if (open?.id === ev.id) { setOpen(null); return; }
    setOpen({ id: ev.id, rows: null });
    try { const r = await api.copyEventExecutions(ev.id); setOpen({ id: ev.id, rows: r.executions }); }
    catch (e) { setOpen({ id: ev.id, rows: [], err: copyErrMsg(e, '불러오지 못했어요') }); }
  };

  if (!d) {
    return <div className="card"><h2>내 팔로워</h2>{err ? <div className="banner warn" style={{ marginBottom: 0 }}>{err}</div> : <div className="empty">불러오는 중…</div>}</div>;
  }
  const s = d.stats;   // 내 대시보드는 숨긴 항목도 전부 온다 (내 숫자는 내가 본다)
  const roi = s.days30Roi ?? 0;
  const hide = hideLocal ?? s.hide;
  const w = d.watcher;
  const totalUnreal = d.followers.reduce((a, f) => a + f.unrealizedPnl, 0);
  return (
    <>
      <div className="card">
        <h2>내 팔로워</h2>
        {err && <div className="banner warn">{err}</div>}
        <div className="grid2 stats">
          <Stat label="팔로워" value={`${s.followers ?? 0}명`} />
          <Stat label="30일 수익률" value={fmtPct(roi)} cls={pnlCls(roi)} sub={roi > 0 ? '이익' : roi < 0 ? '손실' : '변동 없음'} note="30일 손익 ÷ 지금 잔고" />
          {!s.trades ? <Stat label="승률" value="아직 집계 전" sub="마감한 거래가 없어요" /> : <Stat label="승률" value={`${Math.round(s.winRate ?? 0)}%`} sub={`거래 ${s.trades}번`} />}
          <Stat label="팔로워 지금 팔면 손익 합계" value={<PnlWord v={totalUnreal} word={false} />} sub={totalUnreal > 0 ? '이익' : totalUnreal < 0 ? '손실' : '변동 없음'} cls={pnlCls(totalUnreal)} />
        </div>
        <div className="small" style={{ marginTop: '0.6rem', fontWeight: 800, overflowWrap: 'anywhere' }}>
          {w.wsOk ? <span style={{ color: 'var(--ok)' }}>🟢 감시 연결 정상</span> : <span style={{ color: 'var(--danger)' }}>🔴 감시 연결 끊김 (2초마다 확인 중)</span>}
          {' · '}마지막 확인 {w.lastPollAt ? fmtClock(w.lastPollAt) : '아직 없음'}
        </div>
        {w.lastError && <div className="small" style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}>오류: {w.lastError}</div>}
        <div className="hint">내 계좌의 포지션이 바뀌면 팔로워에게 같은 방향·비례 크기로 전달돼요. 배율·손절·익절 변경도 그대로 전달돼요.</div>
      </div>

      <HideCard hide={hide} offline={offline} onSaved={setHideLocal} />

      <div className="card">
        <h2>팔로워 {d.followers.length}명</h2>
        {d.followers.length === 0 && <div className="empty">아직 나를 따라가는 사람이 없어요.</div>}
        {d.followers.map((f) => (
          <div key={f.followId} style={{ borderTop: '1px dashed var(--line)', padding: '0.6rem 0' }}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="hist-title"><span>{f.maskedId}</span><span className={`badge ${f.mode === 'live' ? 'live' : 'neutral'}`}>{f.mode === 'live' ? '실거래' : '연습 엔진'}</span></div>
                <div className="small muted">따라갈 돈 {fmtUsdt(f.copyAmount)} USDT{Math.round(f.copyAmountNow) !== Math.round(f.copyAmount) ? ` (지금 ${fmtUsdt(f.copyAmountNow)})` : ''} · {fmtWhen(f.startedAt)}부터</div>
              </div>
              <div style={{ textAlign: 'right', flex: '0 1 auto', maxWidth: '40%' }}>
                <div className="small muted">정리한 손익 / 지금 팔면 손익</div>
                <div style={{ fontWeight: 900 }}><PnlWord v={f.realizedPnl} word={false} /></div>
                <div style={{ fontWeight: 900 }}><PnlWord v={f.unrealizedPnl} word={false} /></div>
              </div>
            </div>
            {f.positions.length > 0 && <CopyPositionRows positions={f.positions} />}
            {f.lastExecution && <div className="small muted" style={{ marginTop: '0.2rem', overflowWrap: 'anywhere' }}>마지막 실행 <ExecBadge status={f.lastExecution.status} /> {f.lastExecution.detail ?? ''} · {fmtWhen(f.lastExecution.createdAt)}{f.lastExecution.slippagePct != null ? ` · 체결 차이 ${fmtSlip(f.lastExecution.slippagePct)}` : ''}</div>}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>최근 내 매매 → 팔로워 전달</h2>
        {d.events.length === 0 && <div className="empty">아직 감지된 매매가 없어요.</div>}
        {d.events.map((ev) => (
          <div key={ev.id} style={{ borderTop: '1px dashed var(--line)', padding: '0.4rem 0' }}>
            <div className="kv" style={{ alignItems: 'center', gap: '0.5rem', borderBottom: 'none', padding: '0.2rem 0' }}>
              <CoinLogo symbol={ev.symbol} size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="hist-title"><span>{SYMBOL_LABEL[ev.symbol].name}</span><span className={`badge ${kindBadgeCls(ev.kind, ev.direction)}`}>{kindLabel(ev.kind, ev.direction)}</span>{ev.kind === 'close' && <CloseReasonBadge reason={ev.closeReason} />}{ev.leverage ? <span className="badge warn">{ev.leverage}배</span> : null}</div>
                <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{fmtWhen(ev.createdAt)} · {fmtPrice(ev.price)} 달러 · {ev.beforeContracts}→{ev.afterContracts}계약</div>
                <div className="small" style={{ fontWeight: 800 }}>{ev.followerCount == null ? '전달 중…' : `팔로워 ${ev.followerCount}명: 성공 ${ev.okCount ?? 0} · 실패 ${ev.failCount ?? 0} · 건너뜀 ${ev.skippedCount ?? 0}`}</div>
              </div>
            </div>
            <button className="btn small ghost" style={{ minHeight: 56 }} onClick={() => toggle(ev)}>사용자별 결과 {open?.id === ev.id ? '▲' : '▼'}</button>
            {open?.id === ev.id && (
              <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '0.3rem 0.6rem', marginTop: '0.3rem' }}>
                {open.rows == null && <div className="small muted">불러오는 중…</div>}
                {open.err && <div className="small" style={{ color: 'var(--danger)' }}>{open.err}</div>}
                {open.rows && open.rows.length === 0 && !open.err && <div className="small muted">실행 기록이 없어요</div>}
                {open.rows?.map((r) => <ExecRow key={`${r.eventId}-${r.followerId}`} e={r} who={r.loginId} />)}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** 공개 설정: 다른 사람에게 보이는 내 카드·프로필에서 숨길 항목. 누르면 바로 저장 (글자로 상태 표시 — 색만으로 구분하지 않는다) */
const HIDE_ROWS: { key: keyof CopyMasterHide; label: string }[] = [
  { key: 'followers', label: '팔로워 수' }, { key: 'trades', label: '거래 횟수' }, { key: 'winRate', label: '승률' }, { key: 'roi', label: '30일 수익률' }, { key: 'recent', label: '최근 마감 거래' },
];
function HideCard({ hide, offline, onSaved }: { hide: CopyMasterHide; offline: boolean; onSaved: (h: CopyMasterHide) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<keyof CopyMasterHide | null>(null);
  const flip = async (key: keyof CopyMasterHide) => {
    setBusy(key);
    try {
      const r = await api.copyMasterHide({ [key]: !hide[key] });
      onSaved(r.hide);
      toast(r.hide[key] ? '숨겼어요 — 다른 사람에게 보이지 않아요' : '다시 공개했어요');
    } catch (e) { toast(copyErrMsg(e, '저장하지 못했어요'), 'err'); }
    finally { setBusy(null); }
  };
  return (
    <div className="card">
      <h2>공개 설정</h2>
      <div className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>다른 사람에게 보이는 내 카드·프로필에서 숨길 항목을 고르세요. 나와 담당자는 계속 볼 수 있어요.</div>
      <div className="stack">
        {HIDE_ROWS.map(({ key, label }) => (
          <button key={key} type="button" className={`btn ${hide[key] ? '' : 'ghost'}`} style={{ minHeight: 56 }} aria-pressed={hide[key]} disabled={busy != null || offline} onClick={() => flip(key)}>
            <span style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
              <span>{label}</span>
              <span style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>{busy === key ? '저장 중…' : hide[key] ? '🙈 숨김' : '👁 공개 중'}</span>
            </span>
          </button>
        ))}
      </div>
      {offline && <div className="hint">{OFFLINE_TEXT}</div>}
    </div>
  );
}

function Stat({ label, value, cls = '', sub, note }: { label: string; value: ReactNode; cls?: string; sub?: string; note?: string }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '0.5rem 0.6rem', minWidth: 0 }}>
      <div className="small muted">{label}</div>
      <div className={`big ${cls}`} style={{ fontSize: '1.15rem' }}>{value}</div>
      {sub && <div className={`small ${cls}`} style={{ fontWeight: 700 }}>{sub}</div>}
      {note && <div className="small muted" style={{ fontSize: '0.8rem' }}>{note}</div>}
    </div>
  );
}
