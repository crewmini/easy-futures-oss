import { useState } from 'react';
import type { AppState, Me } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { HoldButton } from './HoldButton';

/** 회원 탈퇴: 비밀번호 확인 + 길게 누르기. 실거래 포지션·API 키가 있으면 먼저 정리하도록 안내 */
export function DeleteAccountSheet({ me, state, onClose, onDeleted }: { me: Me; state: AppState; onClose: () => void; onDeleted: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasLivePosition = state.mode === 'live' && state.positions.length > 0;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.deleteAccount(pw); onDeleted(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '탈퇴하지 못했어요'); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>회원 탈퇴</h2></div>
      <div className="banner err" style={{ lineHeight: 1.5 }}>탈퇴하면 이 앱의 계정, 거래소 연결(API 키), 신분증 정보, 설정이 <b>모두 지워지고 되돌릴 수 없어요.</b> 거래소 계정과 그 안의 돈은 그대로 남아요.</div>
      {hasLivePosition && <div className="banner warn">지금 실거래로 걸어둔 것이 있어요. 탈퇴해도 거래소에는 걸어둔 것이 그대로 남으니 먼저 정리하시길 권해요.</div>}
      {me.hasApiKey && <div className="hint">연결된 API 키({me.apiKeyPreview})는 삭제돼요. 거래소 사이트에서도 키를 지우면 더 안전해요.</div>}
      <div className="card stack">
        <label className="col"><span className="muted">확인을 위해 비밀번호</span><input className="num" style={{ textAlign: 'left' }} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {err && <div className="banner err">{err}</div>}
        <HoldButton label="길게 눌러서 탈퇴하기" className="btn danger" busy={busy} busyLabel="처리 중…" disabled={pw.length < 6} onConfirm={go} />
        <button className="btn ghost" onClick={onClose}>아니요, 그대로 둘게요</button>
      </div>
    </div></div>
  );
}
