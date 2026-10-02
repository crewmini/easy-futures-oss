import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { TermsSheet } from './TermsSheet';
import { detectEnv, openInRealBrowser } from './InstallBanner';
import { TERMS_VERSION } from '../content/terms';
import { Logo } from './Logo';

/** 로그인 / 가입 화면. 큰 입력칸, 한 화면에 한 가지. */
export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [uid, setUid] = useState('');
  const [affiliateCode, setAffiliateCode] = useState(() => { try { return (new URLSearchParams(location.search).get('code') ?? '').toUpperCase(); } catch { return ''; } });
  const env = detectEnv();
  const [agreed, setAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const uidMsg = uid.length === 0 ? null : !/^\d+$/.test(uid) ? '숫자만 넣어 주세요' : uid.length !== 8 ? `8자리여야 해요 (지금 ${uid.length}자리)` : !uid.startsWith('9') ? '9로 시작해야 해요' : null;
  const uidOk = /^9\d{7}$/.test(uid);
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      if (mode === 'login') await api.login({ loginId: loginId.trim(), password });
      else await api.signup({ loginId: loginId.trim(), password, inviteCode: inviteCode.trim() || undefined, uid: uid.trim(), termsAgreed: agreed, affiliateCode: affiliateCode.trim() || undefined, termsVersion: TERMS_VERSION });
      onDone();
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : '잠시 후 다시 해보세요'); }
    finally { setBusy(false); }
  };

  return (
    <div className="app">
      <div className="topbar"><h1 className="row" style={{ justifyContent: 'flex-start', gap: '0.4rem' }}><Logo size={30} /> Easy futures</h1></div>
      {env.inApp && (
        <div className="card" style={{ background: '#111', color: '#fff', borderColor: '#111' }}>
          <div style={{ fontWeight: 900, marginBottom: '0.4rem' }}>카카오톡 안에서는 앱으로 쓸 수 없어요</div>
          <div className="small" style={{ opacity: 0.9, lineHeight: 1.5 }}>먼저 아래 버튼으로 {env.isIOS ? 'Safari' : 'Chrome'}에서 연 다음, 그 화면에서 가입·로그인해 주세요. 그래야 홈 화면에 앱처럼 추가할 수 있어요.</div>
          <button type="button" className="btn" style={{ marginTop: '0.6rem', background: '#fff', color: '#111', borderColor: '#fff' }} onClick={openInRealBrowser}>{env.isIOS ? 'Safari' : 'Chrome'}로 열기 →</button>
        </div>
      )}
      <div className="seg" style={{ marginBottom: '0.8rem' }}>
        <button className={`btn ${mode === 'login' ? 'selected' : ''}`} onClick={() => setMode('login')}>로그인</button>
        <button className={`btn ${mode === 'signup' ? 'selected' : ''}`} onClick={() => setMode('signup')}>처음이에요 (가입)</button>
      </div>
      <form className="card stack" onSubmit={submit}>
        <label className="col">
          <span className="muted">아이디</span>
          <input className="num" style={{ textAlign: 'left' }} autoCapitalize="none" autoCorrect="off" autoComplete="username" inputMode="text" value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="영어·숫자 3~20자" />
        </label>
        <label className="col">
          <span className="muted">비밀번호 <span className="small">(6자 이상, 숫자만도 괜찮아요)</span></span>
          <div className="row">
            <input className="num" style={{ textAlign: 'left' }} type={showPw ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn small" style={{ width: 'auto' }} onClick={() => setShowPw((v) => !v)}>{showPw ? '숨기기' : '보기'}</button>
          </div>
        </label>
        {mode === 'signup' && (<>
          <label className="col">
            <span className="muted">가입 코드 <span className="small">(선택 · 받은 코드가 있으면 입력, 없으면 비워 두세요)</span></span>
            <input className="num" style={{ textAlign: 'left' }} autoCapitalize="none" placeholder="없어도 가입돼요" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
          </label>
          <label className="col">
            <span className="muted">거래소 UID <span className="small">(9로 시작하는 숫자 8자리)</span></span>
            <span className="small muted" style={{ lineHeight: 1.4 }}>WOO X Pro 앱의 <b>내 정보(프로필)</b> 맨 위에 있는 숫자예요. 거래소 계정이 아직 없으면 담당자나 가족에게 물어보세요.</span>
            <input className="num" style={{ textAlign: 'left' }} inputMode="numeric" maxLength={8} placeholder="91231234" value={uid} onChange={(e) => setUid(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))} />
            {uidMsg && <span className="small" style={{ color: 'var(--danger)', fontWeight: 700 }}>{uidMsg}</span>}
          </label>
          <label className="col">
            <span className="muted">담당자 코드 <span className="small">(선택 · EF-로 시작, 담당자가 있다면 입력)</span></span>
            <input className="num" style={{ textAlign: 'left' }} autoCapitalize="characters" placeholder="EF-XXXXXX" value={affiliateCode} onChange={(e) => setAffiliateCode(e.target.value.toUpperCase())} />
          </label>
          <div className="card" style={{ margin: 0, padding: '0.7rem 0.9rem', background: 'var(--bg)' }}>
            <label className="row" style={{ justifyContent: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ width: '1.6rem', height: '1.6rem', flex: 'none' }} />
              <span>이용약관을 읽었고 동의합니다. <b>거래의 모든 책임은 본인에게 있습니다.</b></span>
            </label>
            <button type="button" className="btn small" style={{ marginTop: '0.5rem' }} onClick={() => setShowTerms(true)}>약관 전체 보기</button>
          </div>
        </>)}
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" type="submit" disabled={busy || !loginId || password.length < 6 || (mode === 'signup' && (!uidOk || !agreed))}>
          {mode === 'login' ? '들어가기' : '가입하고 들어가기'}
        </button>
      </form>
      <div className="hint" style={{ textAlign: 'center' }}>가입 → 신분증 확인 → 거래소 API 키 연결이 끝나면 거래할 수 있어요. 가족이 대신 가입해 드려도 괜찮지만 신분증은 본인 것이어야 해요.</div>
      {showTerms && <TermsSheet onClose={() => setShowTerms(false)} onAgree={() => { setAgreed(true); setShowTerms(false); }} />}
    </div>
  );
}
