import { FEE_NOTICE, TERMS_SECTIONS, TERMS_VERSION } from '../content/terms';
import { AUTO_TERMS_SECTIONS, AUTO_TERMS_VERSION } from '../content/auto-terms';

/** 이용약관 전문. 가입 화면과 설정에서 연다. */
export function TermsSheet({ onClose, onAgree, closeLabel = '← 뒤로' }: { onClose: () => void; onAgree?: () => void; closeLabel?: string }) {
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>{closeLabel}</button><h2>이용약관</h2></div>
      <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--warn-bg)' }}>
        <div style={{ fontSize: '1.3rem', fontWeight: 900, color: 'var(--warn)', marginBottom: '0.4rem' }}>{FEE_NOTICE.title}</div>
        {FEE_NOTICE.lines.map((l, i) => <div key={i} style={{ fontSize: i === 0 ? '1.05rem' : '1.35rem', fontWeight: 900, lineHeight: 1.4 }}>{l}</div>)}
        <div style={{ marginTop: '0.5rem', fontWeight: 800, color: 'var(--warn)' }}>{FEE_NOTICE.footer}</div>
      </div>
      <div className="banner warn">이 서비스는 거래를 쉽게 하도록 돕는 <b>도구</b>일 뿐입니다. 거래로 생기는 <b>모든 이익과 손실의 책임은 본인</b>에게 있습니다.</div>
      {TERMS_SECTIONS.map((sec) => (
        <div className="card" key={sec.title}>
          <h2>{sec.title}</h2>
          <div style={{ whiteSpace: 'pre-line', fontSize: '0.9rem', lineHeight: 1.55 }}>{sec.body}</div>
        </div>
      ))}
      <h2 style={{ marginTop: '1rem' }}>자동매매 특약 (버전 {AUTO_TERMS_VERSION})</h2>
      {AUTO_TERMS_SECTIONS.map((sec) => (
        <div className="card" key={'auto-' + sec.title}>
          <h2>{sec.title}</h2>
          <div style={{ whiteSpace: 'pre-line', fontSize: '0.9rem', lineHeight: 1.55 }}>{sec.body}</div>
        </div>
      ))}
      <div className="small muted" style={{ textAlign: 'center', marginBottom: '0.8rem' }}>약관 버전 {TERMS_VERSION}</div>
      {onAgree && (
        <div className="bottom"><div className="inner">
          <button className="btn primary" style={{ minHeight: '4.2rem', fontSize: '1.15rem' }} onClick={onAgree}>다 읽었고, 동의합니다</button>
        </div></div>
      )}
    </div></div>
  );
}
