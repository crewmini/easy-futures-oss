import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * 관리자 화면 공용 조각.
 * - useAdminLoad: 한 데이터셋을 처음 한 번 불러오고, 실패하면 오류 문구를 들고 있다가 다시 시도할 수 있게
 * - AdminRow: 굵은 제목 + 회색 설명 한 줄 + 버튼 묶음(넓으면 오른쪽, 좁으면 아래 전체 폭)
 * - Disclosure: ▸/▾ + 글자 접이식(닫혀 있으면 안쪽은 아예 그리지 않음)
 * - SectionHead / LoadSlot / MoreToggle / TabLink: 소제목, 불러오는 중·비었음·오류, 더 보기, 다른 탭으로 가기
 */

export interface Loaded<T> { data: T | null; error: string | null; reload: () => Promise<void>; loaded: boolean }

export function useAdminLoad<T>(fn: () => Promise<T>, toMsg: (e: unknown) => string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => fn().then((r) => { setData(r); setError(null); }).catch((e: unknown) => setError(toMsg(e))), [fn, toMsg]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, loaded: data !== null || error !== null };
}

/** 소제목 + 건수 배지. hot 이면 0건이 아닐 때 주의색(글자 병기) */
export function SectionHead({ title, count, unit = '건', hot = false, right, id }: { title: ReactNode; count?: number; unit?: string; hot?: boolean; right?: ReactNode; id?: string }) {
  return (
    <div className="admin-sec" id={id}>
      <h3 className="admin-sec-title">{title}{count != null && <span className={`badge ${hot && count > 0 ? 'warn' : 'neutral'}`}>{count}{unit}</span>}</h3>
      {right}
    </div>
  );
}

/** 목록 한 줄: 제목 · 설명 · 버튼. extra 는 버튼 아래 전체 폭 블록(더 보기 펼침 등) */
export function AdminRow({ title, meta, actions, extra, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div className="admin-row">
      <div className="admin-row-main">
        <div className="admin-row-title">{title}</div>
        {meta ? <div className="admin-row-meta">{meta}</div> : null}
        {children}
      </div>
      {actions ? <div className="admin-row-actions">{actions}</div> : null}
      {extra ? <div className="admin-row-extra">{extra}</div> : null}
    </div>
  );
}

/** 접이식: 버튼 56px 이상, 열렸을 때만 안쪽을 그린다 */
export function Disclosure({ title, count, defaultOpen = false, children }: { title: ReactNode; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure${open ? ' open' : ''}`}>
      <button type="button" className="disclosure-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="disclosure-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="disclosure-title">{title}</span>
        {count != null && <span className="badge neutral">{count}</span>}
        <span className="disclosure-state muted">{open ? '접기' : '펼치기'}</span>
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}

export const Loading = () => <div className="admin-empty">불러오는 중…</div>;
export const EmptyLine = ({ text }: { text: string }) => <div className="admin-empty">{text}</div>;
export function ErrorBanner({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="banner warn admin-err" role="alert">
      <span style={{ overflowWrap: 'anywhere' }}>⚠️ {text}</span>
      <button type="button" className="btn small" onClick={onRetry}>다시 시도</button>
    </div>
  );
}

/** 불러오는 중 / 오류(+다시 시도) / 비었음 / 내용. 내용은 함수로 받아 데이터가 없을 때 평가하지 않는다 */
export function LoadSlot({ data, error, onRetry, isEmpty = false, emptyText = '없어요.', children }: { data: unknown; error: string | null; onRetry: () => void; isEmpty?: boolean; emptyText?: string; children: () => ReactNode }) {
  return (
    <>
      {error && <ErrorBanner text={error} onRetry={onRetry} />}
      {data == null ? (error ? null : <Loading />) : isEmpty ? <EmptyLine text={emptyText} /> : children()}
    </>
  );
}

/** "더 보기 (N건 더)" / "접기". 숨은 게 없고 접혀 있으면 아무것도 안 그림 */
export function MoreToggle({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  if (!expanded && hidden <= 0) return null;
  return <button type="button" className="btn small ghost" style={{ marginTop: '0.3rem' }} aria-expanded={expanded} onClick={onToggle}>{expanded ? '▴ 접기' : `▾ 더 보기 (${hidden}건 더)`}</button>;
}

export function TabLink({ text, onClick }: { text: string; onClick: () => void }) {
  return <button type="button" className="btn small ghost admin-link" onClick={onClick}>{text} →</button>;
}
