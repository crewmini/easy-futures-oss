import { useState } from 'react';
import type { Me } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';

/** 제휴사(영업 담당자) 신청: 소속·이름·전화번호(+82). 관리자 승인 후 제휴사 페이지가 열린다. */
export function PartnerApplySheet({ me, note, onClose, onDone }: { me: Me; note?: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [company, setCompany] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const phoneDigits = phone.replace(/[^0-9]/g, '');
  const phoneOk = /^0?1[0-9]{8,9}$/.test(phoneDigits);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.partnerApply({ company: company.trim(), name: name.trim(), phone: '+82' + phoneDigits.replace(/^0/, '') }); toast('제휴사 신청을 보냈어요. 승인되면 알려 드릴게요.'); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '신청하지 못했어요'); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>제휴사 신청</h2></div>
      {me.partnerStatus === 'rejected' && <div className="banner err">이전 신청이 거절됐어요{note ? `: ${note}` : ''}. 내용을 고쳐 다시 신청할 수 있어요.</div>}
      <div className="banner warn">제휴사는 관리자 승인 후에만 활동할 수 있어요. 신청 내용은 확인을 위해 보관됩니다.</div>
      <div className="card stack">
        <label className="col"><span className="muted">소속 (회사·팀)</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} maxLength={60} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="예: ○○ 영업1팀" /></label>
        <label className="col"><span className="muted">이름</span><input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 홍길동" /></label>
        <label className="col">
          <span className="muted">전화번호</span>
          <div className="row" style={{ gap: '0.4rem' }}>
            <span className="btn" style={{ width: 'auto', minHeight: '64px', padding: '0 0.8rem', background: 'var(--bg)', fontWeight: 900 }}>+82</span>
            <input className="num" style={{ textAlign: 'left', fontSize: '1.1rem' }} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-1234-5678" />
          </div>
          {phone && !phoneOk && <span className="small" style={{ color: 'var(--danger)', fontWeight: 700 }}>010으로 시작하는 휴대폰 번호를 넣어 주세요</span>}
          {phoneOk && <span className="small muted">저장되는 번호: +82 {phoneDigits.replace(/^0/, '')}</span>}
        </label>
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" disabled={busy || !company.trim() || !name.trim() || !phoneOk} onClick={submit}>{busy ? '보내는 중…' : '신청하기'}</button>
      </div>
      <div className="kv"><span className="k">내 아이디 / UID</span><span className="v small">{me.loginId} / {me.uid ?? '—'}</span></div>
    </div></div>
  );
}
