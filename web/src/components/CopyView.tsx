import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, CopyExecution, CopyFollowMe, CopyFollowSettings, CopyLeftover, CopyMasterCard, CopyStateResponse, Me } from '@easy-futures/shared';
import { COPY_LIMITS, COPY_TERMS_VERSION, MASTER_TERMS_VERSION, SYMBOL_LABEL } from '@easy-futures/shared';
import { api } from '../lib/api';
import { fmtPrice, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';
import { HoldButton } from './HoldButton';
import { OFFLINE_TEXT } from './PositionCard';
import { useToast } from './Toast';
import { TermsBox } from './TermsBox';
import { Collapsible, ShowMore } from './Collapsible';
import { COPY_TERMS, COPY_TERMS_ACK, MASTER_TERMS, MASTER_TERMS_ACK } from '../content/copy-terms';
import { CopyPositionRows, ExecRow, FollowSettingsPicker, LEFTOVER_REASON, MIRROR_NOTE, PnlWord, STOP_REASON, clampSettings, copyErrMsg, dirWord, fmtClock, fmtSlip, fmtWhen } from './CopyCommon';
import { CopyMasterSheet } from './CopyMasterSheet';
import { CopyDashboard } from './CopyDashboard';

/**
 * 고수 따라하기 화면: 따라가는 중 카드 → (고수면) 내 팔로워 → 고수 목록 → 내 기록 → 고수 신청.
 * 5초마다 GET /api/copy (따라가는 중 + 포지션 있으면 3초). 오프라인·화면 숨김이면 쉰다.
 */
export function CopyView({ me, state, offline = false, onOpenKyc, onOpenHistory, onOpenSettings, onGoAuto, onGoTrade, onChanged }: { me: Me; state: AppState; offline?: boolean; onOpenKyc: () => void; onOpenHistory: () => void; onOpenSettings: () => void; onGoAuto: () => void; onGoTrade: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<CopyStateResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [execs, setExecs] = useState<CopyExecution[] | null>(null);
  const [execsErr, setExecsErr] = useState<string | null>(null);   // 기록 로드 실패 (첫 로드 전이면 "다시 시도" 버튼)
  const [busy, setBusy] = useState(false);
  const [openMaster, setOpenMaster] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const offlineRef = useRef(offline); offlineRef.current = offline;
  const fastRef = useRef(false);
  const loaded = useRef(false);

  const load = useCallback(() => api.copy().then((d) => {
    setData(d); setLoadErr(null); setPollErr(null); loaded.current = true;
    fastRef.current = d.me.follow?.status === 'active' && d.me.follow.positions.length > 0;
  }).catch((e) => { const msg = copyErrMsg(e, '불러오지 못했어요'); if (loaded.current) setPollErr(msg); else setLoadErr(msg); }), []);
  const loadExecs = useCallback(() => api.copyExecutions().then((r) => { setExecs(r.executions); setExecsErr(null); }).catch((e) => setExecsErr(copyErrMsg(e, '기록을 불러오지 못했어요'))), []);
  useEffect(() => {
    let alive = true; let timer = 0;
    const tick = async () => {
      if (!alive) return;
      // 첫 로드는 화면이 가려져 있어도 한다 (백그라운드 탭에서 열면 '불러오는 중'에 멈춰 있던 문제) — 그 뒤 폴링만 보일 때
      if (!offlineRef.current && (!loaded.current || document.visibilityState === 'visible')) await load();
      if (alive) timer = window.setTimeout(tick, fastRef.current ? 3000 : 5000);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [load]);
  useEffect(() => {
    void loadExecs();
    const id = window.setInterval(() => { if (!offlineRef.current && document.visibilityState === 'visible') void loadExecs(); }, 30_000);
    return () => window.clearInterval(id);
  }, [loadExecs]);
  const refreshAll = async () => { await load(); void loadExecs(); onChanged(); };

  const unfollow = async (closePositions: boolean) => {
    setBusy(true);
    try {
      const r = await api.copyUnfollow(closePositions);
      const left = r.leftovers ?? 0;
      toast(closePositions ? (r.closed === false ? `따라하기를 멈췄어요. 정리하지 못한 포지션${left ? ` ${left}개` : ''}이 있어요 — 직접 확인해 주세요` : '따라하기를 멈추고 포지션을 정리했어요') : `따라하기를 멈췄어요. 포지션${left ? ` ${left}개` : ''}은 그대로 남아요`);
      if (r.note) toast(r.note);
      await refreshAll();
    } catch (e) { toast(copyErrMsg(e, '멈추지 못했어요'), 'err'); }
    finally { setBusy(false); }
  };

  if (!data) {
    if (loadErr) {
      return (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <div style={{ fontWeight: 800 }}>고수 따라하기 정보를 불러오지 못했어요</div>
          <div className="hint" style={{ marginTop: '0.2rem' }}>{loadErr}</div>
          <button className="btn" style={{ marginTop: '0.5rem' }} onClick={() => { setLoadErr(null); void load(); }}>다시 시도</button>
        </div>
      );
    }
    return <div className="card"><div className="empty">고수 목록과 내 상태를 불러오고 있어요…</div></div>;
  }
  const follow = data.me.follow;
  const following = follow?.status === 'active' ? follow : null;
  const master = data.me.master;
  const isMaster = master?.status === 'approved';

  return (
    <div>
      {pollErr && <div className="banner warn">{pollErr}<br /><span className="small">잠시 후 자동으로 다시 시도해요.</span></div>}

      {/* 따라하기가 멈출 때 정리하지 못한 포지션 — 확인 전까지 맨 위 */}
      {follow?.leftovers && follow.leftovers.length > 0 && (
        <LeftoversCard items={follow.leftovers} busy={busy} onGoTrade={onGoTrade} onAck={async () => {
          setBusy(true);
          try { await api.copyLeftoversAck(); toast('확인했어요. 남은 포지션은 쉬운 거래 탭의 내 상태에서 볼 수 있어요'); await refreshAll(); }
          catch (e) { toast(copyErrMsg(e, '확인 처리를 하지 못했어요'), 'err'); }
          finally { setBusy(false); }
        }} />
      )}

      {/* 따라가는 중 / 멈춤 */}
      {following ? (
        <FollowingCard f={following} serverTime={data.serverTime} offline={offline} busy={busy} onSettings={() => setSettingsOpen(true)} onUnfollow={unfollow} onOpenHistory={onOpenHistory} />
      ) : follow ? (
        <StoppedCard f={follow} onRefollow={() => setOpenMaster(follow.masterId)} />
      ) : (
        <div className="card">
          <h2>고수 따라하기</h2>
          <div className="big">👥 고수의 매매를 그대로 따라가요</div>
          <div className="hint" style={{ marginTop: '0.3rem' }}>아래 목록에서 고수를 골라 "자세히 보기"를 누르면 수익률과 최근 거래를 보고 따라갈 수 있어요. 고수가 사고팔면 내 계좌에서 내가 정한 돈만큼 비례해서 똑같이 사고팔아요.{state.mode === 'paper' ? ' (지금은 관리자 연습 엔진 · 가짜 돈)' : ''}</div>
        </div>
      )}
      {following?.copyTermsOutdated && <ReagreeCard positions={following.positions} busy={busy} setBusy={setBusy} onDone={refreshAll} />}

      {/* 고수면 내 팔로워 대시보드 (+ 소개 수정, 약관 재동의) */}
      {master && master.status !== 'none' && (
        <MasterStatusCard master={master} me={me} state={state} busy={busy} setBusy={setBusy} onDone={refreshAll} />
      )}
      {isMaster && <CopyDashboard offline={offline} />}

      {/* 고수 목록 */}
      <div className="card">
        <h2>고수 목록</h2>
        {data.masters.length === 0 && <div className="empty">아직 등록된 고수가 없어요.</div>}
        {data.masters.map((m) => <MasterRow key={m.userId} m={m} followingId={following?.masterId ?? null} onOpen={() => setOpenMaster(m.userId)} />)}
      </div>

      {/* 내 따라하기 기록 */}
      <div className="card">
        <h2>내 따라하기 기록</h2>
        {execs == null && !execsErr && <div className="empty">불러오는 중…</div>}
        {execs == null && execsErr && (
          <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: '0.5rem' }}>
            <div style={{ fontWeight: 800 }}>기록을 불러오지 못했어요</div>
            <div className="hint" style={{ marginTop: '0.2rem' }}>{execsErr}</div>
            <button className="btn" style={{ marginTop: '0.5rem', minHeight: 56 }} onClick={() => { setExecsErr(null); void loadExecs(); }}>다시 시도</button>
          </div>
        )}
        {execs && execs.length === 0 && <div className="empty">아직 따라 들어간 거래가 없어요.</div>}
        {execs && execs.length > 0 && <ShowMore items={execs} initial={5} step={10} label="지난 기록 더 보기" renderItem={(e) => <ExecRow key={`${e.eventId}-${e.createdAt}`} e={e} />} />}
        <button className="btn" style={{ marginTop: '0.6rem' }} onClick={onOpenHistory}>📋 전체 거래 내역 보기 (손익·수수료 포함)</button>
        <div className="hint">여기는 "언제 고수를 따라 무엇을 했는지"예요. 얼마를 벌고 잃었는지는 전체 거래 내역에서 "고수 따라하기"로 골라 봐요.</div>
      </div>

      {/* 고수 신청 (없거나 거절됐을 때) */}
      {(!master || master.status === 'none' || master.status === 'rejected') && (
        <MasterApplyCard me={me} state={state} note={master?.status === 'rejected' ? master.note : null} rejected={master?.status === 'rejected'} busy={busy} setBusy={setBusy} onOpenKyc={onOpenKyc} onOpenSettings={onOpenSettings} onDone={refreshAll} />
      )}

      {openMaster != null && (
        <CopyMasterSheet masterId={openMaster} me={me} state={state} copy={data} offline={offline} onClose={() => setOpenMaster(null)} onOpenKyc={onOpenKyc} onOpenSettings={onOpenSettings} onGoAuto={onGoAuto} onChanged={refreshAll} />
      )}
      {settingsOpen && following && (
        <CopySettingsSheet f={following} available={state.wallet.available} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); void refreshAll(); }} />
      )}
    </div>
  );
}

/** 따라하기가 멈출 때(직접 멈춤·손실 한도·고수 중지 등) 정리되지 않고 남은 포지션. 손절은 걸려 있지만 더 이상 따라가지 않으니 직접 확인 → "확인했어요"로 지운다 */
function LeftoversCard({ items, busy, onGoTrade, onAck }: { items: CopyLeftover[]; busy: boolean; onGoTrade: () => void; onAck: () => Promise<void> }) {
  return (
    <div className="card" style={{ borderColor: 'var(--danger)' }} role="alert">
      <h2>⚠️ 정리하지 못한 포지션이 있어요</h2>
      <div className="hint" style={{ marginTop: '0.2rem', marginBottom: '0.4rem' }}>따라하기가 멈출 때 정리되지 않은 포지션이에요. 손절은 걸려 있지만 고수를 더 이상 따라가지 않으니 직접 확인해 주세요.</div>
      {items.map((l, i) => (
        <div key={`${l.symbol}-${l.createdAt}-${i}`} className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
          <CoinLogo symbol={l.symbol} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hist-title"><span>{SYMBOL_LABEL[l.symbol].name}</span><span className={`badge ${l.direction === 'long' ? 'up' : 'down'}`}>{dirWord(l.direction)}</span><span className="badge warn">{l.leverage}배</span></div>
            <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{l.contracts}계약 · 평단 {fmtPrice(l.entryPrice)} 달러</div>
            <div className="small" style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>사유: {LEFTOVER_REASON[l.reason] ?? l.reason} · {fmtWhen(l.createdAt)}</div>
          </div>
        </div>
      ))}
      <div className="stack" style={{ marginTop: '0.6rem' }}>
        <button className="btn primary" style={{ minHeight: 56 }} onClick={onGoTrade}>🖐 쉬운 거래에서 확인하기</button>
        <button className="btn" style={{ minHeight: 56 }} disabled={busy} onClick={() => void onAck()}>{busy ? '처리 중…' : '확인했어요 (이 안내 지우기)'}</button>
      </div>
    </div>
  );
}

/** 따라가는 중: 고수·따라갈 돈·손익·손실 한도 게이지·포지션·설정 요약·그만 따라가기 */
function FollowingCard({ f, serverTime, offline, busy, onSettings, onUnfollow, onOpenHistory }: { f: CopyFollowMe; serverTime: number; offline: boolean; busy: boolean; onSettings: () => void; onUnfollow: (closePositions: boolean) => void; onOpenHistory: () => void }) {
  const [choice, setChoice] = useState(false);
  const pnl = f.realizedPnl + f.unrealizedPnl;
  const used = Math.max(0, Math.min(1, f.lossLimitUsed));
  const usedPct = Math.round(used * 100);
  const limitUsdt = (f.settings.copyAmount * f.settings.lossLimitPct) / 100;
  const lostUsdt = used * limitUsdt;
  return (
    <div className="card" style={{ borderColor: 'var(--ok)' }}>
      <h2>따라가는 중</h2>
      <div className="big"><span style={{ color: 'var(--ok)' }}>🟢</span> {f.masterNickname} 고수</div>
      <div className="hint" style={{ marginTop: '0.2rem' }}>{f.mode === 'live' ? '실거래(진짜 돈)' : '연습 엔진(가짜 돈)'} · {fmtWhen(f.startedAt)}부터 · 마지막 확인 {fmtClock(serverTime)}</div>
      <div className="kv"><span className="k">따라갈 돈</span><span className="v">{fmtUsdt(f.settings.copyAmount)} USDT{Math.round(f.copyAmountNow) !== Math.round(f.settings.copyAmount) && <><br /><span className="small muted">손익 반영한 따라갈 돈 {fmtUsdt(f.copyAmountNow)} USDT</span></>}</span></div>
      <div className="kv"><span className="k">지금 손익 (정리한 것 + 들고 있는 것)</span><span className="v"><PnlWord v={pnl} /></span></div>
      {f.avgSlippagePct != null && <div className="kv"><span className="k">30일 평균 체결 차이</span><span className="v" style={{ overflowWrap: 'anywhere' }}>{fmtSlip(f.avgSlippagePct)} <span className="small muted">(고수 대비)</span></span></div>}
      <div style={{ marginTop: '0.6rem' }}>
        <div className="small muted">여기까지 잃으면 멈추기</div>
        <div className="small" style={{ fontWeight: 900, overflowWrap: 'anywhere' }}>지금까지 잃은 돈 {fmtUsdt(lostUsdt)} USDT / 멈추는 선 {fmtUsdt(limitUsdt)} USDT ({usedPct}%)</div>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct} aria-label="손실 한도 사용량"><i className={used >= 0.9 ? 'danger' : used >= 0.7 ? 'warn' : ''} style={{ width: `${usedPct}%` }} /></div>
        <div className="hint" style={{ marginTop: '0.2rem' }}>따라갈 돈의 {f.settings.lossLimitPct}% ({fmtUsdt(limitUsdt)} USDT)를 잃으면 자동으로 멈추고 전부 정리해요.{used >= 0.7 ? ' ⚠️ 한도에 가까워지고 있어요.' : ''}</div>
      </div>
      <div className="hint" style={{ marginBottom: '0.2rem' }}>따라 들어간 포지션 — {MIRROR_NOTE}</div>
      <CopyPositionRows positions={f.positions} />
      <div className="kv" style={{ marginTop: '0.4rem' }}><span className="k" style={{ flex: 'none' }}>내 설정</span><span className="v small">최대 {f.settings.maxLeverage}배 · 손절 -{f.settings.slRoi}% · 한도 {f.settings.lossLimitPct}%</span></div>
      <div className="grid2" style={{ marginTop: '0.5rem' }}>
        <button className="btn" disabled={busy} onClick={onSettings}>⚙️ 설정 바꾸기</button>
        <button className="btn" onClick={onOpenHistory}>📋 거래 내역</button>
      </div>
      <div style={{ marginTop: '0.8rem' }}>
        {offline && <div className="banner err">{OFFLINE_TEXT}</div>}
        {!choice ? (
          <HoldButton label="길게 눌러서 그만 따라가기" className="btn danger" busy={busy} disabled={offline} onConfirm={() => setChoice(true)} />
        ) : (
          <div style={{ border: '2px solid var(--danger)', borderRadius: 12, padding: '0.7rem' }}>
            <div style={{ fontWeight: 900, marginBottom: '0.5rem' }}>따라 들어간 포지션은 어떻게 할까요?</div>
            <div className="stack">
              <button className="btn danger" disabled={busy || offline} onClick={() => onUnfollow(true)}>{busy ? '정리하는 중…' : `포지션도 지금 정리 (${f.positions.length}개)`}</button>
              <button className="btn" disabled={busy || offline} onClick={() => onUnfollow(false)}>포지션은 두고 멈추기 (손절은 그대로)</button>
              <button className="btn ghost" disabled={busy} onClick={() => setChoice(false)}>취소 — 계속 따라가기</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 멈춘 따라하기: 사유 + 남은 포지션 안내 (남은 포지션은 이 따라하기의 것만 — 지갑 전체가 아니라) */
function StoppedCard({ f, onRefollow }: { f: CopyFollowMe; onRefollow: () => void }) {
  const reason = f.stopReason ? STOP_REASON[f.stopReason] : '따라하기가 멈췄어요.';
  const positionsLeft = f.positions.length > 0;
  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2>따라하기 멈춤</h2>
      <div className="banner warn" style={{ marginBottom: '0.4rem' }}>
        <b>{f.masterNickname} 고수</b> — {reason}{f.stoppedAt ? <span className="small"> ({fmtWhen(f.stoppedAt)})</span> : null}
        {positionsLeft && <div style={{ marginTop: '0.3rem' }}>{f.stopReason === 'loss_limit' ? '정리하지 못한 포지션이 있어요 — 직접 정리하세요.' : '열린 포지션은 직접 정리하세요.'} "쉬운 거래" 탭의 내 상태에서 정리할 수 있어요.</div>}
      </div>
      <div className="kv"><span className="k">이 고수와의 손익 (정리한 것)</span><span className="v"><PnlWord v={f.realizedPnl} /></span></div>
      {f.positions.length > 0 && <CopyPositionRows positions={f.positions} />}
      {f.stopReason === 'terms_outdated' ? <button className="btn primary" style={{ marginTop: '0.5rem' }} onClick={onRefollow}>새로 따라하기 (설정 다시 정하기)</button>
        : <div className="hint">다시 따라가려면 아래 고수 목록에서 고르면 돼요.</div>}
    </div>
  );
}

/** 따라가는 중인데 특약이 바뀐 경우: 동의 전까지 새 진입만 멈추고, 이미 든 포지션의 정리·손절 변경·손실 한도는 계속 따라간다 */
function ReagreeCard({ positions, busy, setBusy, onDone }: { positions: CopyFollowMe['positions']; busy: boolean; setBusy: (b: boolean) => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [read, setRead] = useState(false);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.copyFollowSettings({ agree: true, copyTermsVersion: COPY_TERMS_VERSION }); toast('특약에 다시 동의했어요. 이어서 따라가요.'); await onDone(); }
    catch (e) { setErr(copyErrMsg(e, '동의를 저장하지 못했어요')); }
    finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2>특약이 바뀌었어요</h2>
      <div className="banner warn">따라하기 특약이 바뀌었어요. 동의 전까지는 고수의 새 진입은 따라가지 않아요. 이미 들어간 포지션의 정리·손절 변경은 계속 따라가요.</div>
      {positions.length > 0 && (<>
        <div className="hint" style={{ marginTop: 0, marginBottom: '0.2rem' }}>이미 들어간 포지션 (계속 따라가요)</div>
        <CopyPositionRows positions={positions} />
      </>)}
      <TermsBox title="고수 따라하기 특약" version={COPY_TERMS_VERSION} sections={COPY_TERMS} read={read} onRead={() => setRead(true)} />
      <AgreeRow read={read} agree={agree} setAgree={setAgree} text={COPY_TERMS_ACK} />
      {err && <div className="banner err">{err}</div>}
      <button className="btn primary" disabled={busy || !read || !agree} onClick={submit}>다시 동의하고 이어서 따라하기</button>
    </div>
  );
}

export function AgreeRow({ read, agree, setAgree, text }: { read: boolean; agree: boolean; setAgree: (b: boolean) => void; text: string }) {
  return (
    <>
      <label className="row" style={{ justifyContent: 'flex-start', gap: '0.6rem', margin: '0.6rem 0', opacity: read ? 1 : 0.5 }}>
        <input type="checkbox" checked={agree} disabled={!read} onChange={(e) => setAgree(e.target.checked)} style={{ width: '1.6rem', height: '1.6rem', flex: 'none' }} />
        <span>{text}</span>
      </label>
      {!read && <div className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>끝까지 내려 읽으면 동의할 수 있어요.</div>}
    </>
  );
}

/** 고수 목록 한 장 */
function MasterRow({ m, followingId, onOpen }: { m: CopyMasterCard; followingId: number | null; onOpen: () => void }) {
  // 고수가 숨긴 항목(hide)은 서버가 아예 보내지 않는다(내 카드는 보낸다) → 값이 없으면 그 자리에 "비공개"
  // 목록 카드의 오른쪽 타일은 30일 수익률 대신 승률 (2026-10-02 사용자 결정 — 초보자가 수익률 숫자만 보고 겁먹는 일을 줄이려고). 수익률은 "자세히 보기"에서 본다
  const noStats = m.trades === 0;   // 마감 거래가 없으면 승률 0 대신 "아직 집계 전" (거래 횟수를 숨겼으면 판단 불가 → 값 그대로)
  const line = [
    m.followers == null ? '팔로워 비공개' : `팔로워 ${m.followers}명`,
    noStats ? '아직 집계 전 (마감한 거래 없음)' : m.trades == null ? '거래 횟수 비공개' : `거래 ${m.trades}번`,
  ].filter((x): x is string => !!x).join(' · ');
  const wr = m.winRate;
  return (
    <div style={{ borderTop: '1px dashed var(--line)', padding: '0.7rem 0' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: '1.15rem', overflowWrap: 'anywhere' }}>👤 {m.nickname} {followingId === m.userId && <span className="badge ok">따라가는 중</span>}</div>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{line}</div>
        </div>
        {wr == null ? (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="small muted">승률</div>
            <div className="big">비공개</div>
            <div className="small muted" style={{ fontWeight: 800 }}>고수가 숨겼어요</div>
          </div>
        ) : noStats ? (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="small muted">승률</div>
            <div className="big">집계 전</div>
            <div className="small muted" style={{ fontWeight: 800 }}>마감 거래 없음</div>
          </div>
        ) : (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="small muted">승률</div>
            <div className="big" style={{ whiteSpace: 'nowrap' }}>{Math.round(wr)}%</div>
            <div className="small muted" style={{ fontWeight: 800 }}>{m.trades != null ? `거래 ${m.trades}번 중` : '마감 거래 기준'}</div>
          </div>
        )}
      </div>
      <div className="hist-title" style={{ marginTop: '0.3rem', fontWeight: 700 }}>
        <span className="small muted">지금:</span>
        {m.positions.length === 0 ? <span className="badge neutral">들고 있는 것 없음</span> : m.positions.map((p) => <span key={p.symbol} className={`badge ${p.direction === 'long' ? 'up' : 'down'}`}>{SYMBOL_LABEL[p.symbol].name} {dirWord(p.direction)}</span>)}
      </div>
      {m.intro && <div className="small" style={{ marginTop: '0.4rem', overflowWrap: 'anywhere' }}>{m.intro}</div>}
      <button className="btn primary" style={{ marginTop: '0.5rem' }} onClick={onOpen}>자세히 보기 →</button>
    </div>
  );
}

/** 고수 상태 카드: 대기/중지/승인(소개 수정·약관 재동의) */
function MasterStatusCard({ master, me, state, busy, setBusy, onDone }: { master: NonNullable<CopyStateResponse['me']['master']>; me: Me; state: AppState; busy: boolean; setBusy: (b: boolean) => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [intro, setIntro] = useState(master.intro ?? '');
  const [read, setRead] = useState(false);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saveIntro = async () => {
    setBusy(true);
    try { await api.copyMasterIntro(intro.trim()); toast('소개를 저장했어요'); setEditing(false); await onDone(); }
    catch (e) { toast(copyErrMsg(e, '저장하지 못했어요'), 'err'); }
    finally { setBusy(false); }
  };
  const reagree = async () => {
    setBusy(true); setErr(null);
    try { await api.copyMasterApply({ nickname: master.nickname ?? '', intro: master.intro ?? '', agree: true, masterTermsVersion: MASTER_TERMS_VERSION }); toast('고수 약관에 다시 동의했어요'); await onDone(); }
    catch (e) { setErr(copyErrMsg(e, '동의를 저장하지 못했어요')); }
    finally { setBusy(false); }
  };
  if (master.status === 'pending') {
    return (
      <div className="card">
        <h2>고수 신청</h2>
        <div className="banner warn" style={{ marginBottom: 0 }}>⏳ 승인 기다리는 중 — 닉네임 <b>{master.nickname}</b>{master.appliedAt ? ` · 신청 ${fmtWhen(master.appliedAt)}` : ''}. 담당자가 확인하면 고수 목록에 올라가요.</div>
      </div>
    );
  }
  if (master.status === 'suspended') {
    return (
      <div className="card" style={{ borderColor: 'var(--danger)' }}>
        <h2>고수 활동 중지</h2>
        <div className="banner err" style={{ marginBottom: 0 }}>고수 활동이 중지됐어요{master.note ? `: ${master.note}` : ''}. 나를 따르던 팔로워는 모두 멈췄어요. 담당자에게 문의해 주세요.</div>
      </div>
    );
  }
  if (master.status !== 'approved') return null;
  const liveOk = state.mode === 'live' && me.hasApiKey;
  return (
    <div className="card" style={{ borderColor: 'var(--ok)' }}>
      <h2>나는 고수예요</h2>
      <div className="big">👤 {master.nickname}</div>
      {!liveOk && <div className="banner warn" style={{ marginTop: '0.4rem' }}>고수는 거래소 API 키가 연결돼 있어야 매매가 감지돼요. {state.mode === 'paper' ? '지금은 관리자 연습 엔진이에요.' : '지금은 API 키가 없어요.'}</div>}
      {master.masterTermsOutdated && (
        <div style={{ marginTop: '0.4rem' }}>
          <div className="banner warn">고수 약관이 바뀌었어요. 다시 읽고 동의해야 팔로워에게 내 매매가 전달돼요.</div>
          <TermsBox title="고수 약관" version={MASTER_TERMS_VERSION} sections={MASTER_TERMS} read={read} onRead={() => setRead(true)} endLabel="— 약관 끝 —" />
          <AgreeRow read={read} agree={agree} setAgree={setAgree} text={MASTER_TERMS_ACK} />
          {err && <div className="banner err">{err}</div>}
          <button className="btn primary" disabled={busy || !read || !agree} onClick={reagree}>다시 동의하기</button>
        </div>
      )}
      {editing ? (
        <div style={{ marginTop: '0.5rem' }}>
          <textarea className="num" style={{ textAlign: 'left', fontSize: '1rem', minHeight: '6rem', fontFamily: 'inherit', resize: 'vertical' }} maxLength={COPY_LIMITS.introMax} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="내 매매 스타일을 팔로워에게 소개해 주세요" />
          <div className="small muted" style={{ textAlign: 'right' }}>{intro.length}/{COPY_LIMITS.introMax}자</div>
          <div className="grid2" style={{ marginTop: '0.3rem' }}>
            <button className="btn primary" disabled={busy} onClick={saveIntro}>저장</button>
            <button className="btn ghost" disabled={busy} onClick={() => { setEditing(false); setIntro(master.intro ?? ''); }}>취소</button>
          </div>
        </div>
      ) : (
        <>
          <div className="small" style={{ marginTop: '0.4rem', overflowWrap: 'anywhere' }}>{master.intro || <span className="muted">아직 소개가 없어요.</span>}</div>
          <button className="btn small" style={{ marginTop: '0.5rem' }} onClick={() => setEditing(true)}>✏️ 소개 고치기</button>
        </>
      )}
    </div>
  );
}

/** 고수 신청 카드: 조건 안내 + 닉네임/소개 + 고수 약관 */
function MasterApplyCard({ me, state, note, rejected, busy, setBusy, onOpenKyc, onOpenSettings, onDone }: { me: Me; state: AppState; note: string | null; rejected: boolean; busy: boolean; setBusy: (b: boolean) => void; onOpenKyc: () => void; onOpenSettings: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [nickname, setNickname] = useState('');
  const [intro, setIntro] = useState('');
  const [read, setRead] = useState(false);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 대부분의 사용자는 고수가 될 생각이 없다 → 기본은 접어 두고, 거절 안내가 있거나 쓰기 시작했으면 펼쳐 둔다 (폼 상태는 여기 있어 접어도 안 사라진다)
  const [opened, setOpened] = useState(rejected);
  const [nMin, nMax] = COPY_LIMITS.nickname;
  const nick = nickname.trim();
  const nickOk = nick.length >= nMin && nick.length <= nMax;
  const kycOk = me.kycStatus === 'approved';
  const liveOk = state.mode === 'live' && me.hasApiKey;
  const started = nickname !== '' || intro !== '' || agree;
  const open = opened || started;
  const apply = async () => {
    setBusy(true); setErr(null);
    try { await api.copyMasterApply({ nickname: nick, intro: intro.trim(), agree: true, masterTermsVersion: MASTER_TERMS_VERSION }); toast('고수 신청을 보냈어요. 담당자 확인 후 목록에 올라가요.'); await onDone(); }
    catch (e) { setErr(copyErrMsg(e, '신청하지 못했어요')); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <Collapsible title="고수로 활동하기" summary="신분증 확인 + API 키 연결 후 담당자 승인" open={open} onToggle={setOpened} openLabel="신청하기">
        {rejected && <div className="banner err">이전 신청이 거절됐어요{note ? `: ${note}` : ''}. 내용을 고쳐 다시 신청할 수 있어요.</div>}
        <div className="hint" style={{ marginTop: 0 }}>고수가 되면 내 매매가 팔로워 계좌에 그대로 복제돼요. 조건: 신분증 확인 + 거래소 API 키 연결. 담당자 승인 후 목록에 올라가요. 보수는 없어요.</div>
        <div className="stack" style={{ marginTop: '0.5rem' }}>
          <div className="kv compact"><span className="k">신분증 확인</span><span className="v">{kycOk ? '완료 ✅' : <button className="btn small" style={{ width: 'auto', display: 'inline-flex' }} onClick={onOpenKyc}>🪪 하러 가기 ✗</button>}</span></div>
          <div className="kv compact"><span className="k">거래소 API 키 연결</span><span className="v">{liveOk ? '연결됨 ✅' : <span>{state.mode === 'paper' ? '연습 엔진 ✗' : 'API 키 없음 ✗'}<br /><button className="btn small" style={{ width: 'auto', display: 'inline-flex', marginTop: '0.3rem' }} onClick={onOpenSettings}>⚙️ 설정 열기</button></span>}</span></div>
        </div>
        <label className="col" style={{ marginTop: '0.6rem' }}><span className="muted">닉네임 ({nMin}~{nMax}자, 목록에 보여요)</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} maxLength={nMax} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="예: 느긋한곰" /></label>
        {nickname && !nickOk && <div className="small" style={{ color: 'var(--danger)', fontWeight: 700 }}>{nMin}~{nMax}자로 지어 주세요</div>}
        <label className="col" style={{ marginTop: '0.6rem' }}><span className="muted">소개 (최대 {COPY_LIMITS.introMax}자)</span><textarea className="num" style={{ textAlign: 'left', fontSize: '1rem', minHeight: '6rem', fontFamily: 'inherit', resize: 'vertical' }} maxLength={COPY_LIMITS.introMax} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="예: 비트코인 위주로 하루 1~2번, 손절은 꼭 지켜요" /></label>
        <div className="small muted" style={{ textAlign: 'right' }}>{intro.length}/{COPY_LIMITS.introMax}자</div>
        <TermsBox title="고수 약관" version={MASTER_TERMS_VERSION} sections={MASTER_TERMS} read={read} onRead={() => setRead(true)} endLabel="— 약관 끝 —" />
        <AgreeRow read={read} agree={agree} setAgree={setAgree} text={MASTER_TERMS_ACK} />
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" disabled={busy || !read || !agree || !nickOk || !kycOk || !liveOk} onClick={apply}>{busy ? '보내는 중…' : '고수 신청하기'}</button>
      </Collapsible>
    </div>
  );
}

/** 설정 바꾸기 시트 (따라가는 중) */
function CopySettingsSheet({ f, available, onClose, onSaved }: { f: CopyFollowMe; available: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<CopyFollowSettings>(f.settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.copyFollowSettings(clampSettings(draft)); toast('설정을 저장했어요'); onSaved(); }
    catch (e) { setErr(copyErrMsg(e, '저장하지 못했어요')); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>따라하기 설정 바꾸기</h2></div>
      <div className="banner warn">{f.masterNickname} 고수를 따라가는 중이에요. 바꾼 설정은 다음 진입부터 적용돼요. 이미 들어간 포지션의 손절은 그대로예요.</div>
      <div className="card">
        <FollowSettingsPicker draft={draft} setDraft={setDraft} available={available} />
        {err && <div className="banner err" style={{ marginTop: '0.6rem' }}>{err}</div>}
        <button className="btn primary" style={{ marginTop: '0.8rem' }} disabled={busy || draft.copyAmount < COPY_LIMITS.copyAmountMin || draft.copyAmount > available} onClick={save}>{busy ? '저장하는 중…' : '이 설정으로 저장'}</button>
      </div>
    </div></div>
  );
}
