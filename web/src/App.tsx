import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, Symbol } from '@easy-futures/shared';
import { api, ApiError } from './lib/api';
import { AuthScreen } from './components/AuthScreen';
import { KeysSheet } from './components/KeysSheet';
import { HistorySheet } from './components/HistorySheet';
import { KycSheet } from './components/KycSheet';
import { AdminSheet } from './components/AdminSheet';
import { PartnerSheet } from './components/PartnerSheet';
import { PartnerApplySheet } from './components/PartnerApplySheet';
import { TermsSheet } from './components/TermsSheet';
import { PasswordSheet } from './components/PasswordSheet';
import { DeleteAccountSheet } from './components/DeleteAccountSheet';
import { TERMS_VERSION } from '@easy-futures/shared';
import { AutoView } from './components/AutoView';
import { CopyView } from './components/CopyView';
import { Logo } from './components/Logo';
import { useAppState } from './hooks/useAppState';
import { useScale } from './hooks/useScale';
import { PriceHeader, SymbolToggle } from './components/PriceHeader';
import { WalletCard } from './components/WalletCard';
import { PositionCard } from './components/PositionCard';
import { FIRST_ORDER_KEY, OrderWizard } from './components/OrderWizard';
import { SettingsSheet } from './components/SettingsSheet';
import { InstallBanner } from './components/InstallBanner';
import { ToastProvider, useToast } from './components/Toast';

export default function App() {
  return <ToastProvider><Main /></ToastProvider>;
}
function Toastless({ children }: { children: React.ReactNode }) { return <>{children}</>; }

type View = 'easy' | 'auto' | 'copy';
const firstOrderDone = () => { try { return localStorage.getItem(FIRST_ORDER_KEY) === '1'; } catch { return false; } };

function Main() {
  const { state, error, offline, unauthorized, refresh } = useAppState();
  const toast = useToast();
  const [scale, setScale] = useScale();
  const [me, setMe] = useState<Me | null>(null);
  const loadMe = useCallback(() => api.me().then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { void loadMe(); }, [loadMe, unauthorized]);
  // 내 정보를 못 받았으면 상태 폴링에 맞춰 다시 시도 (AI 자동매매 탭이 비지 않게). state 는 시세마다 바뀌므로 5초에 한 번만.
  const meRetryAt = useRef(0);
  useEffect(() => {
    if (me || !state || unauthorized) return;
    const now = Date.now(); if (now - meRetryAt.current < 5000) return;
    meRetryAt.current = now; void loadMe();
  }, [me, state, unauthorized, loadMe]);
  const afterAuth = () => { void loadMe(); void refresh(); };
  const changed = () => { void loadMe(); void refresh(); };
  const [symbol, setSymbol] = useState<Symbol>(() => { try { return (localStorage.getItem('ef.symbol') as Symbol) || 'BTCUSDT'; } catch { return 'BTCUSDT'; } });
  const [sheet, setSheet] = useState<null | 'order' | 'settings' | 'keys' | 'history' | 'admin' | 'terms' | 'partner' | 'partnerApply' | 'kyc' | 'password' | 'delete'>(null);
  const [partnerNote, setPartnerNote] = useState<string | null>(null);
  const [keysFrom, setKeysFrom] = useState<'home' | 'settings'>('settings'); // 키 시트를 어디서 열었는지 → 뒤로 갈 곳
  const [view, setView] = useState<View>(() => { try { const v = localStorage.getItem('ef.view') as View; return v === 'auto' || v === 'copy' ? v : 'easy'; } catch { return 'easy'; } });
  useEffect(() => { try { localStorage.setItem('ef.view', view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { if (me?.partnerStatus === 'rejected') api.partnerApplication().then((r) => setPartnerNote(r.application?.note ?? null)).catch(() => {}); }, [me?.partnerStatus]);
  useEffect(() => { try { localStorage.setItem('ef.symbol', symbol); } catch { /* ignore */ } }, [symbol]);

  if (unauthorized) return <AuthScreen onDone={afterAuth} />;
  // 인터넷이 없어 서버에 못 닿으면 로그아웃하지 않는다 (세션이 살아 있는데 화면만 로그인으로 가면 혼란). 서버가 답했으면(401 포함) 로그아웃 처리.
  const logout = async () => {
    try { await api.logout(); }
    catch (e) { if (!(e instanceof ApiError) || e.status === 0) { toast('인터넷이 없어 로그아웃하지 못했어요. 연결 후 다시 눌러 주세요', 'err'); return; } }
    setSheet(null); setMe(null); void refresh();
  };
  // 약관이 바뀌었으면 다시 동의부터, 임시 비밀번호면 새 비밀번호부터 (그 전엔 거래 API 가 막힌다)
  // 재동의 저장 실패는 조용히 넘기지 않는다 — 안내 후 다시 누르게 (changed() 도 부르지 않아 화면이 그대로 남는다)
  if (me?.termsOutdated) return <Toastless><TermsSheet onClose={logout} onAgree={async () => { try { await api.agreeTerms(TERMS_VERSION); } catch { toast('동의를 저장하지 못했어요. 연결을 확인하고 다시 눌러 주세요', 'err'); return; } changed(); }} closeLabel="로그아웃" /></Toastless>;
  if (me?.mustChangePassword) return <Toastless><PasswordSheet forced onDone={changed} /></Toastless>;

  if (!state) {
    return (
      <div className="app">
        <div className="topbar"><h1 className="row" style={{ justifyContent: 'flex-start', gap: '0.4rem' }}><Logo size={30} /> Easy futures</h1></div>
        {offline || error ? <div className="banner err">{error ?? '서버에 연결할 수 없어요'}<br /><span className="small">잠시 후 자동으로 다시 시도해요.</span></div> : <div className="empty">불러오는 중…</div>}
      </div>
    );
  }

  const hasPrice = !!(state.prices[symbol]?.mark || state.prices[symbol]?.last);
  // 실거래 준비: 서버가 needsSetup 을 주면 그걸, 없으면 내 정보(신분증·API 키)로 판단. 연습 엔진은 관리자 테스트용이라 준비 카드를 띄우지 않는다.
  const needs = state.needsSetup; // true = 아직 빠짐 (shared AppState)
  const kycDone = needs ? !needs.kyc : me?.kycStatus === 'approved';
  const apiDone = needs ? !needs.apiKey : !!me?.hasApiKey;
  const setupDone = kycDone && apiDone;
  const onboarding = !!me && state.mode === 'live' && !setupDone;
  // 실거래인데 준비가 덜 된 경우만 (관리자가 연습 엔진으로 테스트할 때는 예전처럼)
  const canOrder = state.mode === 'paper' || setupDone;
  return (
    <div className="app">
      <div className="topbar">
        <h1 className="row" style={{ justifyContent: 'flex-start', gap: '0.4rem' }}><Logo size={30} /> Easy futures</h1>
        <div className="row">
          {state.mode === 'paper' && <span className="mode paper">{me?.isAdmin ? '관리자: 연습 엔진' : '연습 엔진'}</span>}
          <button className="btn small ghost" style={{ width: 'auto' }} onClick={() => setSheet('settings')} aria-label="설정">⚙️ 설정</button>
        </div>
      </div>
      {offline && <div className="banner err">연결이 끊겼어요 — 다시 연결 중… (주문 버튼은 잠시 꺼져요)</div>}
      {!offline && error && <div className="banner err">{error}<br /><span className="small">잠시 후 자동으로 다시 시도해요.</span></div>}
      {firstOrderDone() && <InstallBanner />}
      <div className="seg seg3 tabs3" role="tablist" aria-label="이용 방식" style={{ marginBottom: '0.7rem' }}>
        <button role="tab" aria-selected={view === 'easy'} className={`btn ${view === 'easy' ? 'selected' : ''}`} onClick={() => setView('easy')}>🖐 쉬운 거래</button>
        <button role="tab" aria-selected={view === 'auto'} className={`btn ${view === 'auto' ? 'selected' : ''}`} onClick={() => setView('auto')}>🤖 AI 자동매매</button>
        <button role="tab" aria-selected={view === 'copy'} className={`btn ${view === 'copy' ? 'selected' : ''}`} onClick={() => setView('copy')}>👥 고수 따라하기</button>
      </div>
      {view !== 'easy' ? (
        me ? (
          view === 'auto'
            ? <AutoView me={me} state={state} offline={offline} onOpenKyc={() => setSheet('kyc')} onOpenKeys={() => { setKeysFrom('home'); setSheet('keys'); }} onOpenHistory={() => setSheet('history')} onChanged={changed} />
            : <CopyView me={me} state={state} offline={offline} onOpenKyc={() => setSheet('kyc')} onOpenHistory={() => setSheet('history')} onOpenSettings={() => setSheet('settings')} onGoAuto={() => setView('auto')} onGoTrade={() => setView('easy')} onChanged={changed} />
        ) : (
          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <div style={{ fontWeight: 800 }}>내 정보를 불러오지 못했어요</div>
            <div className="hint" style={{ marginTop: '0.2rem' }}>{view === 'auto' ? 'AI 자동매매' : '고수 따라하기'} 화면은 내 정보가 있어야 열려요. 잠시 후 자동으로 다시 시도해요.</div>
            <button className="btn" style={{ marginTop: '0.5rem' }} onClick={() => void loadMe()}>다시 불러오기</button>
          </div>
        )
      ) : (<>
      <SymbolToggle value={symbol} onChange={setSymbol} />
      <div style={{ height: '0.7rem' }} />
      <PriceHeader state={state} symbol={symbol} />
      {onboarding && me ? (
        <OnboardingCard me={me} kycDone={kycDone} apiDone={apiDone} onOpenKyc={() => setSheet('kyc')} onOpenKeys={() => { setKeysFrom('home'); setSheet('keys'); }} />
      ) : (<>
        <PositionCard state={state} symbol={symbol} offline={offline} onChanged={refresh} />
        <WalletCard state={state} />
      </>)}
      </>)}

      {view === 'easy' && <div className="bottom"><div className="inner">
        {!canOrder && <div className="small muted" style={{ textAlign: 'center', fontWeight: 700, marginBottom: '0.35rem' }}>{!kycDone ? '신분증 확인이 끝나야 걸 수 있어요' : '거래소 API 키를 연결해야 걸 수 있어요'}</div>}
        <button className="btn primary" style={{ minHeight: '4.2rem', fontSize: '1.2rem' }} disabled={offline || !hasPrice || !canOrder} onClick={() => setSheet('order')}>＋ 새로 걸기</button>
      </div></div>}

      {sheet === 'order' && <OrderWizard state={state} symbol={symbol} offline={offline} onClose={() => setSheet(null)} onDone={refresh} />}
      {sheet === 'settings' && <SettingsSheet state={state} me={me} scale={scale} setScale={setScale} onClose={() => setSheet(null)} onChanged={changed} onOpenKeys={() => { setKeysFrom('settings'); setSheet('keys'); }} onOpenHistory={() => setSheet('history')} onOpenAdmin={() => setSheet('admin')} onOpenPartner={() => setSheet('partner')} onOpenPartnerApply={() => setSheet('partnerApply')} onOpenKyc={() => setSheet('kyc')} onOpenPassword={() => setSheet('password')} onOpenDelete={() => setSheet('delete')} onOpenTerms={() => setSheet('terms')} onLogout={logout} />}
      {sheet === 'admin' && <AdminSheet onClose={() => setSheet('settings')} />}
      {sheet === 'kyc' && me && <KycSheet me={me} onDone={() => { changed(); setSheet(null); }} onClose={() => setSheet(null)} />}
      {sheet === 'password' && <PasswordSheet onClose={() => setSheet('settings')} onDone={() => { changed(); setSheet('settings'); }} />}
      {sheet === 'delete' && me && <DeleteAccountSheet me={me} state={state} onClose={() => setSheet('settings')} onDeleted={() => { setSheet(null); setMe(null); void refresh(); }} />}
      {sheet === 'partner' && me && <PartnerSheet me={me} onClose={() => setSheet('settings')} />}
      {sheet === 'partnerApply' && me && <PartnerApplySheet me={me} note={partnerNote} onClose={() => setSheet('settings')} onDone={() => { changed(); setSheet('settings'); }} />}
      {sheet === 'terms' && <TermsSheet onClose={() => setSheet('settings')} />}
      {sheet === 'history' && <HistorySheet usdtKrw={state.settings.usdtKrw} onClose={() => setSheet('settings')} />}
      {sheet === 'keys' && me && <KeysSheet me={me} onClose={() => setSheet(keysFrom === 'home' ? null : 'settings')} onChanged={changed} />}
    </div>
  );
}

/** 실거래 준비 카드: ① 신분증 확인 ② 거래소 API 키 연결. 끝난 단계는 ✅, 남은 단계는 큰 버튼 하나. 둘 다 끝나면 이 카드 대신 내 상태·지갑이 보인다. */
function OnboardingCard({ me, kycDone, apiDone, onOpenKyc, onOpenKeys }: { me: Me; kycDone: boolean; apiDone: boolean; onOpenKyc: () => void; onOpenKeys: () => void }) {
  const kycWord = kycDone ? '완료 ✅' : me.kycStatus === 'pending' ? '확인 중 ⏳' : me.kycStatus === 'rejected' ? '다시 제출 필요 ✗' : '아직 안 했어요 ✗';
  const kycHint = kycDone ? null : me.kycStatus === 'pending' ? '담당자가 확인하는 중이에요. 보통 하루 안에 끝나요.' : me.kycStatus === 'rejected' ? (me.kycNote ?? '신분증을 확인할 수 없었어요. 다시 찍어 주세요.') : '본인 신분증을 사진으로 한 번만 보내면 돼요.';
  return (
    <div className="card onboard" style={{ borderColor: 'var(--warn)' }}>
      <h2>실거래 준비</h2>
      <div className="big">두 가지만 끝내면 바로 거래할 수 있어요</div>
      <div className={`onb-step ${kycDone ? 'done' : ''}`}>
        <div className="onb-num" aria-hidden="true">{kycDone ? '✅' : '①'}</div>
        <div className="onb-body">
          <div className="onb-title">신분증 확인 <span className={`badge ${kycDone ? 'ok' : me.kycStatus === 'pending' ? 'warn' : 'neutral'}`}>{kycWord}</span></div>
          {kycHint && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{kycHint}</div>}
          {!kycDone && <button className="btn primary" onClick={onOpenKyc}>🪪 {me.kycStatus === 'pending' ? '제출한 신분증 보기' : me.kycStatus === 'rejected' ? '신분증 다시 제출하기' : '신분증 확인하기'}</button>}
        </div>
      </div>
      <div className={`onb-step ${apiDone ? 'done' : ''}`}>
        <div className="onb-num" aria-hidden="true">{apiDone ? '✅' : '②'}</div>
        <div className="onb-body">
          <div className="onb-title">거래소 API 키 연결 <span className={`badge ${apiDone ? 'ok' : 'neutral'}`}>{apiDone ? `연결됨 ✅ (${me.apiKeyPreview ?? ''})` : '아직 안 했어요 ✗'}</span></div>
          {!apiDone && <div className="small muted">WOO X Pro에서 만든 키를 넣으면 내 계좌로 주문이 나가요. 만드는 방법은 다음 화면에 있어요.</div>}
          {!apiDone && <button className={`btn ${kycDone ? 'primary' : ''}`} onClick={onOpenKeys}>🔑 거래소 API 키 연결하기</button>}
        </div>
      </div>
      <div className="hint" style={{ marginBottom: 0 }}>두 단계가 모두 끝나면 아래 "＋ 새로 걸기"로 주문할 수 있어요. 순서는 상관없어요.</div>
    </div>
  );
}
