import { useState } from 'react';
import type { Me } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';
import { HoldButton } from './HoldButton';

/** 거래소 API 키 등록. 시크릿은 서버로 한 번 보내고 화면에 다시 보여주지 않는다. */
export function KeysSheet({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.saveKeys({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), memo: memo.trim() });
      toast('거래소 연결이 확인됐어요 ✅'); onChanged(); onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : '저장하지 못했어요'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.deleteKeys(); toast('연결을 해제했어요. 다시 연결하기 전에는 주문할 수 없어요.'); onChanged(); onClose(); }
    catch { toast('해제하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };

  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>거래소 연결 (API 키)</h2></div>
      {me.hasApiKey && (
        <div className="card">
          <div className="banner ok">연결됨: 키 {me.apiKeyPreview}</div>
          <div className="hint">새 키를 넣으면 기존 키를 덮어씁니다.</div>
          <div style={{ marginTop: '0.6rem' }}><HoldButton label="연결 해제 (길게 누르기)" className="btn danger" onConfirm={remove} disabled={busy} /></div>
        </div>
      )}
      <div className="card">
        <h2>WOO X Pro에서 키 만들기</h2>
        <ol className="small" style={{ paddingLeft: '1.2rem', lineHeight: 1.6 }}>
          <li>WOO X Pro 사이트 → Account → <b>API Management</b></li>
          <li>Memo에 아무 이름(예: easy) 입력 — 아래 "메모"에 <b>똑같이</b> 적어야 해요</li>
          <li>Authority는 <b>Read-Only, Future-Trade</b> 선택</li>
          <li>Binding IP Address는 <b>비워두세요</b></li>
          <li>Submit 후 나오는 Access Key와 Secret Key를 복사</li>
        </ol>
      </div>
      <div className="card stack">
        <label className="col"><span className="muted">Access Key</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} autoCapitalize="none" autoCorrect="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        <label className="col"><span className="muted">Secret Key</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} type="password" autoCapitalize="none" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} /></label>
        <label className="col"><span className="muted">메모 (키 만들 때 적은 이름)</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} autoCapitalize="none" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" disabled={busy || !apiKey || !apiSecret || !memo} onClick={save}>{busy ? '거래소에 확인 중…' : '거래소 연결하기'}</button>
        <div className="hint">Secret Key는 서버에 암호화되어 저장되고, 이 화면에 다시 표시되지 않아요.</div>
      </div>
    </div></div>
  );
}
