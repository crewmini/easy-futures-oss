import { useRef, useState } from 'react';
import type { KycDocType, Me } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';

const DOCS: { key: KycDocType; label: string }[] = [
  { key: 'id_card', label: '주민등록증' },
  { key: 'driver_license', label: '운전면허증' },
  { key: 'passport', label: '여권' },
];

/** 신분증 사진 제출. 기기에서 1000px 이하로 줄여 보내고, 서버는 암호화해 저장한다. */
export function KycSheet({ me, onDone, onClose }: { me: Me; onDone: () => void; onClose: () => void }) {
  const toast = useToast();
  const [docType, setDocType] = useState<KycDocType | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    try { setImage(await shrink(file)); }
    catch { setErr('사진을 읽지 못했어요. 다시 찍어 주세요.'); }
  };
  const submit = async () => {
    if (!docType || !image) return;
    setBusy(true); setErr(null);
    try { await api.submitKyc({ docType, image }); toast('신분증을 제출했어요. 확인이 끝나면 알려 드릴게요.'); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '제출하지 못했어요'); }
    finally { setBusy(false); }
  };

  // 이미 제출해서 확인 중이면 다시 제출할 수 없다 — 상태만 보여준다
  if (me.kycStatus === 'pending') {
    return (
      <div className="sheet"><div className="inner">
        <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>본인 확인 (신분증)</h2></div>
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <div style={{ fontWeight: 900, fontSize: '1.15rem' }}>신분증을 제출했어요 ⏳</div>
          <div className="hint" style={{ lineHeight: 1.5 }}>담당자가 확인하는 중이에요. 보통 하루 안에 끝나요. 확인이 끝나면(그리고 거래소 API 키를 연결하면) 바로 거래할 수 있어요.</div>
        </div>
        <button className="btn primary" onClick={onClose}>← 돌아가기</button>
      </div></div>
    );
  }

  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>본인 확인 (신분증)</h2></div>
      <div className="banner ok"><b>거래를 시작하려면</b> 본인 신분증을 한 번만 확인해요. 확인이 끝나면 다시 할 필요 없어요.</div>
      {me.kycStatus === 'rejected' && <div className="banner err">다시 제출이 필요해요: {me.kycNote ?? '신분증을 확인할 수 없었어요'}</div>}
      <div className="banner warn" style={{ lineHeight: 1.5 }}>
        <b>본인 신분증만</b> 제출하세요. 타인의 신분증을 쓰거나 위·변조하면 주민등록법·여권법·형법 등에 따라 <b>형사 처벌</b>을 받을 수 있고, 모든 손해를 본인이 책임집니다.
      </div>
      <div className="card">
        <h2>1. 어떤 신분증인가요?</h2>
        <div className="grid3">
          {DOCS.map((d) => <button key={d.key} className={`btn ${docType === d.key ? 'selected' : ''}`} onClick={() => setDocType(d.key)}>{d.label}</button>)}
        </div>
      </div>
      <div className="card">
        <h2>2. 사진 찍기</h2>
        <ul style={{ margin: '0 0 0.6rem', paddingLeft: '1.2rem', fontSize: '0.9rem', lineHeight: 1.6 }}>
          <li>이름, 생년월일, 발급일이 <b>선명하게</b> 보이게</li>
          <li>주민등록번호 <b>뒷자리 7자리는 손가락이나 종이로 가리고</b> 찍어 주세요 (법에 따라 뒷자리는 받지 않아요)</li>
          <li>빛 반사가 없게, 신분증이 화면에 꽉 차게</li>
        </ul>
        {/* capture 를 빼야 아이폰이 "사진 찍기 / 사진 보관함 / 파일" 을 모두 보여준다 */}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="btn" onClick={() => fileRef.current?.click()}>📷 {image ? '다시 찍기' : '사진 찍기 / 고르기'}</button>
        {image && <img src={image} alt="신분증 미리보기" style={{ width: '100%', borderRadius: 12, marginTop: '0.6rem', border: '1px solid var(--line)' }} />}
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="stack">
        <button className="btn primary" disabled={busy || !docType || !image} onClick={submit}>{busy ? '보내는 중…' : '제출하기'}</button>
        <button className="btn ghost" onClick={onClose}>나중에 할게요</button>
      </div>
      <div className="hint">사진은 암호화해서 보관하고, 확인이 끝나면 바로 지웁니다.</div>
    </div></div>
  );
}

/** 긴 변 1000px, JPEG 0.8 로 줄인 data URL */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bmp, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.8);
}
