import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';

/** 비밀번호 바꾸기. forced=true 면 임시 비밀번호로 들어온 상태라 닫을 수 없다. */
export function PasswordSheet({ forced = false, onClose, onDone }: { forced?: boolean; onClose?: () => void; onDone: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = cur.length >= 1 && next.length >= 6 && next === next2 && next !== cur;
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.changePassword(cur, next); toast('비밀번호를 바꿨어요 ✅'); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '바꾸지 못했어요'); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head">{!forced && onClose && <button className="btn ghost" onClick={onClose}>← 뒤로</button>}<h2>{forced ? '새 비밀번호 정하기' : '비밀번호 바꾸기'}</h2></div>
      {forced && <div className="banner warn">임시 비밀번호로 들어오셨어요. 계속 쓰려면 <b>내가 정한 새 비밀번호</b>를 만들어 주세요.</div>}
      <div className="card stack">
        <label className="col"><span className="muted">{forced ? '임시 비밀번호 (받은 숫자)' : '지금 비밀번호'}</span><input className="num" style={{ textAlign: 'left' }} type={show ? 'text' : 'password'} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="col"><span className="muted">새 비밀번호 <span className="small">(6자 이상, 숫자만도 괜찮아요)</span></span><input className="num" style={{ textAlign: 'left' }} type={show ? 'text' : 'password'} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="col"><span className="muted">새 비밀번호 한 번 더</span><input className="num" style={{ textAlign: 'left' }} type={show ? 'text' : 'password'} autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} /></label>
        {next2 && next !== next2 && <div className="small" style={{ color: 'var(--danger)', fontWeight: 700 }}>두 비밀번호가 달라요</div>}
        <button type="button" className="btn small" onClick={() => setShow((v) => !v)}>{show ? '숨기기' : '비밀번호 보기'}</button>
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" disabled={busy || !ok} onClick={submit}>{busy ? '바꾸는 중…' : '이 비밀번호로 정하기'}</button>
      </div>
    </div></div>
  );
}
