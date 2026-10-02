import { useEffect, useRef } from 'react';

export interface TermsSection { title: string; body: string }

/**
 * 특약/약관 상자 — 끝까지 스크롤해야 읽은 것으로 본다 (짧아서 스크롤이 없으면 바로 읽음 처리).
 * AI 자동매매 특약·카피 특약·고수 약관이 같이 쓴다. 부모가 read 상태를 들고 있어 시트를 다시 열면 처음부터 읽는다.
 */
export function TermsBox({ title, version, sections, read, onRead, endLabel = '— 특약 끝 —' }: {
  title: string; version: string; sections: TermsSection[]; read: boolean; onRead: () => void; endLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const check = () => { const el = ref.current; if (!el) return; if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) onRead(); };
  useEffect(() => { check(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <div style={{ marginTop: '0.6rem' }}>
      <div className="row"><b>{title}</b><span className={`badge ${read ? 'ok' : 'warn'}`} style={{ flex: 'none' }}>{read ? '읽음 ✅' : '끝까지 읽어 주세요 ↓'}</span></div>
      <div className="small muted">버전 {version}</div>
      <div ref={ref} onScroll={check} style={{ maxHeight: '16rem', overflowY: 'auto', border: '2px solid var(--line)', borderRadius: '12px', padding: '0.8rem', marginTop: '0.4rem', background: '#fff', fontSize: '0.95rem', lineHeight: 1.55 }}>
        {sections.map((sec) => (
          <div key={sec.title} style={{ marginBottom: '0.8rem' }}>
            <div style={{ fontWeight: 900 }}>{sec.title}</div>
            {sec.body.split('\n').map((line, i) => <div key={i}>{line}</div>)}
          </div>
        ))}
        <div style={{ fontWeight: 900, color: 'var(--danger)' }}>{endLabel}</div>
      </div>
    </div>
  );
}
