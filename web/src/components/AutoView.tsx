import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, AutoExecution, AutoStateResponse, Me } from '@easy-futures/shared';
import { SYMBOL_LABEL } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { fmtSigned, fmtUsdt } from '../lib/format';
import { HoldButton } from './HoldButton';
import { CoinLogo } from './CoinLogo';
import { OFFLINE_TEXT, PositionCard } from './PositionCard';
import { useToast } from './Toast';
import { TermsBox } from './TermsBox';
import { Collapsible, ShowMore } from './Collapsible';
import { AUTO_TERMS_ACK, AUTO_TERMS_SECTIONS, AUTO_TERMS_VERSION } from '../content/auto-terms';

const PCTS = [5, 10, 20, 30];
const LEVS = [2, 3, 5, 10];
const SLS = [10, 20, 30];

type Draft = { pct: number; maxLeverage: number; defaultSlRoi: number };

/** AI 자동매매 화면: 자격/신청 → 켜기끄기 → 설정 → 최근 신호와 내 실행 → 비상 버튼 */
export function AutoView({ me, state, offline = false, onOpenKyc, onOpenKeys, onOpenHistory, onChanged }: { me: Me; state: AppState; offline?: boolean; onOpenKyc: () => void; onOpenKeys: () => void; onOpenHistory: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<AutoStateResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const [termsRead, setTermsRead] = useState(false);
  const [draft, setDraftRaw] = useState<Draft>({ pct: 10, maxLeverage: 5, defaultSlRoi: 20 });
  const [dirty, setDirty] = useState(false); // 사용자가 고친 뒤 아직 저장 안 함 → 폴링이 덮어쓰지 않는다
  const [editing, setEditing] = useState(false); // 승인 뒤 설정 카드: 한 줄 요약 ↔ 전체 폼
  const setDraft = (d: Draft) => { setDraftRaw(d); setDirty(true); };
  const loaded = useRef(false);
  /** applyDraft: 서버 값을 편집칸에 넣을지. 첫 로드와 저장 직후에만 true. 15초 폴링은 false (편집 중 보호) */
  const load = useCallback((applyDraft = false) => api.auto().then((d) => {
    setData(d); setLoadErr(null);
    if (applyDraft || !loaded.current) { setDraftRaw({ pct: d.settings.pct, maxLeverage: d.settings.maxLeverage, defaultSlRoi: d.settings.defaultSlRoi }); setDirty(false); loaded.current = true; }
  }).catch((e) => { const msg = e instanceof ApiError ? e.message : '불러오지 못했어요'; if (loaded.current) toast(msg, 'err'); else setLoadErr(msg); }), [toast]);
  useEffect(() => { void load(); const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15000); return () => window.clearInterval(id); }, [load]);

  const save = async (patch: Partial<Draft> & { enabled?: boolean }, msg: string) => {
    setBusy(true);
    try { await api.autoSettings(patch); toast(msg); await load(true); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '저장하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };
  /** 설정 카드 접기: 저장 안 한 변경은 서버 값으로 되돌린다 */
  const closeSettings = () => {
    if (data) { setDraftRaw({ pct: data.settings.pct, maxLeverage: data.settings.maxLeverage, defaultSlRoi: data.settings.defaultSlRoi }); setDirty(false); }
    setEditing(false);
  };
  const apply = async () => {
    setBusy(true);
    try { await api.autoApply({ agree: true, autoTermsVersion: AUTO_TERMS_VERSION, ...draft }); toast('AI 자동매매를 신청했어요. 담당자 확인 후 켤 수 있어요.'); await load(true); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '신청하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };
  const panic = async () => {
    setBusy(true);
    try { const r = await api.autoPanic(); toast(`AI 자동매매를 껐고 걸어둔 것 ${r.closed.length}개를 정리했어요${r.failed.length ? ` (실패 ${r.failed.length})` : ''}`); await load(true); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패했어요', 'err'); }
    finally { setBusy(false); }
  };

  if (!data) {
    if (loadErr) {
      return (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <div style={{ fontWeight: 800 }}>AI 자동매매 정보를 불러오지 못했어요</div>
          <div className="hint" style={{ marginTop: '0.2rem' }}>{loadErr}</div>
          <button className="btn" style={{ marginTop: '0.5rem' }} onClick={() => { setLoadErr(null); void load(); }}>다시 시도</button>
        </div>
      );
    }
    return <div className="empty">불러오는 중…</div>;
  }
  const st = data.status;
  const on = st === 'approved' && data.settings.enabled;
  const keyOk = state.mode === 'paper' || me.hasApiKey; // 실거래는 API 키가 있어야 신호가 실행된다 (연습 엔진은 관리자 테스트)
  const offNote = st === 'approved' && !on && data.note ? data.note : null; // 서버가 자동으로 끈 사유 (키 삭제·모드 전환·신분증 거절·키 거절)

  return (
    <div>
      {/* 상태 카드 */}
      <div className="card" style={{ borderColor: on ? 'var(--ok)' : undefined }}>
        <h2>AI 자동매매</h2>
        {data.autoTermsOutdated && <div className="banner warn">자동매매 특약이 바뀌었어요. 아래 신청 카드에서 특약을 다시 읽고 동의해야 신호가 실행돼요.</div>}
        {offNote && <div className="banner warn">{offNote}</div>}
        {st === 'approved' ? (<>
          <div className="big">{on ? <span className="ok" style={{ color: 'var(--ok)' }}>🟢 켜져 있어요</span> : '⚪ 꺼져 있어요'}</div>
          <div className="hint" style={{ marginTop: '0.2rem' }}>{on ? `신호 1건에 내 돈의 ${data.settings.pct}% · 최대 ${data.settings.maxLeverage}배 · 손절 항상 붙음` : '켜면 담당자 봇의 신호대로 내 계좌에서 자동으로 사고팔아요.'}{state.mode === 'paper' ? ' (관리자 연습 엔진 · 가짜 돈)' : ''}</div>
          {/* API 키 없이는 켤 수 없다 (서버도 400 NO_API_KEY) — "켜져 있어요"인데 신호를 전부 건너뛰는 상태를 막는다 */}
          {!keyOk && <div className="banner warn" style={{ marginTop: '0.5rem' }}>🔑 거래소 API 키를 먼저 연결해 주세요. 키가 없으면 신호가 와도 실행되지 않아요. <button className="btn small" style={{ marginTop: '0.4rem' }} onClick={onOpenKeys}>🔑 거래소 API 키 연결하기</button></div>}
          <div className="stack" style={{ marginTop: '0.7rem' }}>
            {on ? <button className="btn" disabled={busy} onClick={() => save({ enabled: false }, 'AI 자동매매를 껐어요. 걸어둔 것은 그대로 남아요.')}>AI 자동매매 끄기 (걸어둔 것은 그대로)</button>
                : <HoldButton label="길게 눌러서 AI 자동매매 켜기" className="btn primary" busy={busy} disabled={!keyOk || offline} onConfirm={() => save({ enabled: true }, 'AI 자동매매를 켰어요 🟢')} />}
            {!on && offline && <div className="hint" style={{ textAlign: 'center' }}>{OFFLINE_TEXT}</div>}
          </div>
          {/* 긴 설명은 접어 둔다 — 상태와 켜기/끄기 버튼만 바로 보이게 */}
          <Collapsible title="자세한 설명" style={{ marginTop: '0.4rem' }}>
            <div className="hint" style={{ marginTop: 0, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              담당자 봇이 저점을 찾아 신호를 보내면, 내 거래소 계좌에서 신호 1건당 내 돈의 {data.settings.pct}%를 최대 {data.settings.maxLeverage}배로 자동 진입해요. 손절은 항상 붙고(신호에 없으면 내 돈 기준 -{data.settings.defaultSlRoi}%), 봇이 정리 신호를 보내면 자동으로 정리해요.
              <br />끄면 새 신호만 멈추고 걸어둔 것은 그대로 남아요. 걸어둔 것까지 한 번에 정리하려면 아래 <b>비상</b> 버튼을 쓰세요. 자동으로 잡힌 것도 "지금 걸어둔 것"에서 손절·익절을 바꾸거나 직접 정리할 수 있어요.
            </div>
          </Collapsible>
        </>) : st === 'pending' ? (
          <div className="banner warn" style={{ marginBottom: 0 }}>신청을 확인하는 중이에요. 담당자가 결제를 확인하고 승인하면 여기서 켤 수 있어요.</div>
        ) : st === 'suspended' ? (
          <div className="banner err" style={{ marginBottom: 0 }}>AI 자동매매가 중지됐어요{data.note ? `: ${data.note}` : ''}. 담당자에게 문의하거나 다시 신청해 주세요.</div>
        ) : null}
      </div>

      {/* 지금 걸어둔 것 — 쉬운 거래의 '내 상태' 와 같은 카드 (AI 자동매매로 잡힌 것 포함) */}
      {state.positions.length > 0 && (
        <>
          <div className="hint" style={{ marginTop: 0 }}>지금 걸어둔 것 — AI 자동매매로 잡힌 것도 여기서 손절·익절을 바꾸거나 정리할 수 있어요.</div>
          {state.positions.map((p) => <PositionCard key={p.symbol} state={state} symbol={p.symbol} offline={offline} onChanged={onChanged} />)}
        </>
      )}

      {/* 신청 */}
      {(st === 'none' || st === 'rejected' || (st === 'approved' && data.autoTermsOutdated)) && (
        <div className="card">
          <h2>AI 자동매매 신청</h2>
          {me.kycStatus !== 'approved' && <div className="banner warn">먼저 본인 확인(신분증)이 끝나야 신청할 수 있어요. <button className="btn small" style={{ marginTop: '0.4rem' }} onClick={onOpenKyc}>🪪 신분증 확인하기</button></div>}
          {me.kycStatus === 'approved' && !keyOk && <div className="banner warn">거래소 API 키를 연결해야 신호를 실행할 수 있어요. <button className="btn small" style={{ marginTop: '0.4rem' }} onClick={onOpenKeys}>🔑 거래소 API 키 연결하기</button></div>}
          <div className="banner err" style={{ lineHeight: 1.5 }}>
            AI 자동매매는 담당자 봇의 신호대로 <b>내 계좌에서 자동으로 사고파는</b> 기능이에요. 이익도 손실도 본인 책임이며, 봇이 틀리면 돈을 잃을 수 있어요. 언제든 끌 수 있고 비상 버튼으로 전부 정리할 수 있어요.
          </div>
          <div className="hint" style={{ marginTop: 0 }}>AI 자동매매는 유료예요. 이용료와 결제 방법은 담당자가 안내해요. 결제가 확인되면 승인돼요.</div>
          <SettingsPicker draft={draft} setDraft={setDraft} />
          <TermsBox title="자동매매 특약" version={AUTO_TERMS_VERSION} sections={AUTO_TERMS_SECTIONS} read={termsRead} onRead={() => setTermsRead(true)} />
          <label className="row" style={{ justifyContent: 'flex-start', gap: '0.6rem', margin: '0.6rem 0', opacity: termsRead ? 1 : 0.5 }}>
            <input type="checkbox" checked={agree} disabled={!termsRead} onChange={(e) => setAgree(e.target.checked)} style={{ width: '1.6rem', height: '1.6rem', flex: 'none' }} />
            <span>{AUTO_TERMS_ACK}</span>
          </label>
          {!termsRead && <div className="hint" style={{ marginTop: 0 }}>특약을 끝까지 내려 읽으면 동의할 수 있어요.</div>}
          <button className="btn primary" disabled={busy || !agree || !termsRead || me.kycStatus !== 'approved'} onClick={apply}>AI 자동매매 신청하기</button>
        </div>
      )}

      {/* 설정 (승인 후) */}
      {st === 'approved' && (
        <div className="card">
          {/* 평소엔 한 줄 요약만. "설정 바꾸기"를 누르면 전체 폼. 고치는 중(dirty)에는 접히지 않는다 */}
          <Collapsible
            title="AI 자동매매 설정"
            summary={`전체 시드의 ${data.settings.pct}% · 최대 ${data.settings.maxLeverage}배 · 손절 ${data.settings.defaultSlRoi}%`}
            open={editing || dirty}
            onToggle={(o) => (o ? setEditing(true) : closeSettings())}
            openLabel="설정 바꾸기"
          >
            <SettingsPicker draft={draft} setDraft={setDraft} />
            <div className="row" style={{ marginTop: '0.6rem' }}>
              <button className="btn" disabled={busy} onClick={async () => { await save(draft, '설정을 저장했어요'); setEditing(false); }}>이 설정으로 저장</button>
              {dirty && <span className="badge warn" style={{ flex: 'none', whiteSpace: 'nowrap' }}>저장 안 됨</span>}
            </div>
          </Collapsible>
        </div>
      )}

      {/* 비상 */}
      {st === 'approved' && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2>비상</h2>
          <div className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>AI 자동매매를 끄고, 지금 걸어둔 것을 <b>전부</b> 지금 가격에 정리해요.</div>
          {offline && <div className="banner err">{OFFLINE_TEXT} 급하면 거래소 앱에서 직접 정리하세요.</div>}
          <HoldButton label="길게 눌러서 AI 자동매매 끄기 + 전부 정리" className="btn danger" busy={busy} busyLabel="정리하는 중…" disabled={offline} onConfirm={panic} />
        </div>
      )}

      {/* 내 실행 기록 — 거래 내역과 같은 줄 모양. 손익까지 보려면 전체 거래 내역으로 */}
      <div className="card">
        <h2>내 AI 자동매매 기록</h2>
        {data.myExecutions.length === 0 && <div className="empty">아직 자동으로 실행된 거래가 없어요.</div>}
        {/* 최근 5건만 먼저, 나머지는 "더 보기" — 날짜 묶음은 보이는 만큼만 */}
        <ShowMore items={data.myExecutions} initial={5} step={10} label="지난 기록 더 보기" render={(visible) => groupByDay(visible).map(([day, items]) => (
          <div key={day}>
            <div className="small muted" style={{ fontWeight: 800, margin: '0.5rem 0 0.2rem' }}>{day}</div>
            {items.map((e) => {
              const sig = e.signal;
              const time = new Date(e.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={e.id} className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  {sig ? <CoinLogo symbol={sig.symbol} size={30} /> : <span style={{ width: 30, flex: 'none' }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="hist-title">
                      <span style={{ overflowWrap: 'anywhere' }}>{sig ? SYMBOL_LABEL[sig.symbol].name : e.signalId}</span>
                      {sig && <span className={`badge ${sig.action === 'close' ? 'warn' : sig.action === 'update' ? 'ok' : sig.direction === 'long' ? 'up' : 'down'}`}>{actionLabel(sig.action, sig.direction)}</span>}
                      <span className={`badge ${e.mode === 'live' ? 'live' : 'neutral'}`}>{e.mode === 'live' ? '실거래' : '연습 엔진'}</span>
                    </div>
                    {e.detail && <div style={{ fontWeight: 800, fontSize: '0.9rem', overflowWrap: 'anywhere' }}>{e.detail}</div>}
                    <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{time}{sig?.note ? ` · ${sig.note}` : ''}{e.mode === 'paper' ? ' · 연습 엔진(가짜 돈)' : ''}</div>
                  </div>
                  <div style={{ flex: '0 1 auto', maxWidth: '50%', textAlign: 'right', overflowWrap: 'anywhere' }}>
                    <span className={`badge ${e.status === 'ok' ? 'ok' : e.status === 'failed' ? 'fail' : 'warn'}`}>{e.status === 'ok' ? '완료' : e.status === 'failed' ? '실패' : '건너뜀'}</span>
                    <ExecResult e={e} />
                  </div>
                </div>
              );
            })}
          </div>
        ))} />
        <button className="btn" style={{ marginTop: '0.6rem' }} onClick={onOpenHistory}>📋 전체 거래 내역 보기 (손익·수수료 포함)</button>
        <div className="hint">여기는 "언제 어떤 신호로 무엇을 했는지"예요. 얼마를 벌고 잃었는지는 전체 거래 내역에서 봐요.</div>
      </div>

      {/* 최근 신호 */}
      <div className="card">
        <h2>최근 신호</h2>
        {data.recentSignals.length === 0 && <div className="empty">아직 신호가 없어요.</div>}
        <ShowMore items={data.recentSignals} initial={3} step={10} label="지난 신호 더 보기" renderItem={(s) => (
          <div key={s.id} className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
            <CoinLogo symbol={s.symbol} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{SYMBOL_LABEL[s.symbol].name} <span className={`badge ${s.action === 'close' ? 'warn' : s.action === 'update' ? 'ok' : s.direction === 'long' ? 'up' : 'down'}`}>{actionLabel(s.action, s.direction)}</span> {s.leverage ? <span className="badge warn">{s.leverage}배</span> : null}</div>
              <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{new Date(s.createdAt).toLocaleString('ko-KR')}{s.note ? ` · ${s.note}` : ''}{s.followerCount != null ? ` · ${s.okCount}/${s.followerCount}명 실행` : ''}</div>
            </div>
          </div>
        )} />
      </div>
      <div className="small muted" style={{ textAlign: 'center' }}>지갑: 쓸 수 있는 돈 {fmtUsdt(state.wallet.available)} USDT · 신호 1건당 약 {fmtUsdt(state.wallet.available * (data.settings.pct / 100))} USDT 투입</div>
    </div>
  );
}

function SettingsPicker({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const lev = draft.maxLeverage;
  return (
    <div className="stack">
      <div>
        <div className="hint" style={{ marginTop: 0 }}>신호 1건에 내 돈의 몇 %를 쓸까요? (최대 30%)</div>
        <div className="grid4">{PCTS.map((p) => <button key={p} className={`btn small ${draft.pct === p ? 'selected' : ''}`} onClick={() => setDraft({ ...draft, pct: p })}>{p}%</button>)}</div>
        <div className="hint">최대 30%인 이유: 봇은 저점마다 <b>최대 3번</b>(첫 진입 1번 + 추가 진입 2번) 나눠 들어가요. 그래서 한 흐름에 최대 {draft.pct * 3}%까지 들어갈 수 있고, 30%로 잡으면 어떤 경우에도 내 돈의 90%를 넘지 않아요.</div>
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>최대 배율 (신호가 더 높아도 이 이상은 안 써요)</div>
        <div className="grid4">{LEVS.map((l) => <button key={l} className={`btn small ${lev === l ? 'selected' : ''}`} onClick={() => setDraft({ ...draft, maxLeverage: l })}>{l}배</button>)}</div>
        <div className="hint">더 세밀하게 정하려면 막대를 미세요 (1배 ~ 50배).</div>
        <input type="range" className="slider" min={1} max={50} step={1} value={lev} aria-label="최대 배율" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value) })} />
        <div className="row"><span className="badge warn">{lev}배</span><span className="small muted">가격이 1% 움직이면 내 돈의 {lev}% 변동</span></div>
        {lev >= 20 && <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.2rem' }}>⚠️ 20배 이상은 가격이 {(100 / lev).toFixed(1)}%만 반대로 가도 강제정리될 수 있어요.</div>}
        {lev >= 10 && lev < 20 && <div className="hint" style={{ marginTop: '0.2rem' }}>⚠️ 10배 이상은 가격이 조금만 반대로 가도 돈을 잃기 쉬워요.</div>}
      </div>
      <div>
        <div className="hint" style={{ marginTop: 0 }}>기본 손절 (신호에 손절이 없을 때, 내 돈 기준 · 최대 30%)</div>
        <div className="grid3">{SLS.map((v) => <button key={v} className={`btn small ${draft.defaultSlRoi === v ? 'selected' : ''}`} onClick={() => setDraft({ ...draft, defaultSlRoi: v })}>-{v}%</button>)}</div>
        <input type="range" className="slider" min={5} max={30} step={1} value={draft.defaultSlRoi} aria-label="기본 손절" onChange={(e) => setDraft({ ...draft, defaultSlRoi: Number(e.target.value) })} />
        <div className="row"><span className="badge down">-{draft.defaultSlRoi}%</span><span className="small muted">내 돈의 {draft.defaultSlRoi}%를 잃으면 자동으로 정리</span></div>
      </div>
    </div>
  );
}

/** 진입/불타기 실행의 결과 칸: 그 흐름의 순손익과 정리 여부. 값이 없으면 아무것도 안 보여준다. */
function ExecResult({ e }: { e: AutoExecution }) {
  const action = e.signal?.action;
  if (e.status !== 'ok' || (action !== 'open' && action !== 'add')) return null;
  if (e.pnl != null) {
    const cls = e.pnl > 0 ? 'up' : e.pnl < 0 ? 'down' : '';
    return (
      <>
        <div className={`v ${cls}`} style={{ fontWeight: 900, marginTop: '0.2rem' }}>{fmtSigned(e.pnl)} USDT</div>
        <div className="small muted">{e.closed ? '정리됨' : '진행 중 (지금까지)'}</div>
      </>
    );
  }
  if (e.closed === false) return <div className="small muted" style={{ marginTop: '0.2rem' }}>진행 중</div>;
  return null;
}

function groupByDay<T extends { createdAt: number }>(items: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const it of items) { const day = new Date(it.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }); (out.get(day) ?? out.set(day, []).get(day)!).push(it); }
  return [...out.entries()];
}

function actionLabel(action: 'open' | 'add' | 'update' | 'close', direction: 'long' | 'short' | null): string {
  const dir = direction === 'long' ? '오른다' : direction === 'short' ? '내린다' : '';
  if (action === 'open') return `${dir} 진입`;
  if (action === 'add') return `${dir} 불타기`;
  if (action === 'update') return '손절/익절 갱신';
  return '정리';
}
