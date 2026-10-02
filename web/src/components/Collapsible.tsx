import { useState, type CSSProperties, type ReactNode } from 'react';

/**
 * 접었다 펼치는 구역. 어르신용: 머리글 전체가 큰 버튼(≥56px)이고 "펼치기/접기" 글자를 같이 써서 화살표만으로 뜻을 전하지 않는다.
 * 닫혀 있으면 children 을 그리지 않는다(화면 길이 줄이기). 편집 중인 폼처럼 상태를 잃으면 안 되는 내용은 부모가 상태를 들고 있어야 한다.
 * open/onToggle 을 주면 부모가 열림 상태를 쥔다(제어형). 없으면 defaultOpen 으로 스스로 관리한다.
 */
export function Collapsible({ title, summary, count, defaultOpen = false, open: openProp, onToggle, openLabel = '펼치기', closeLabel = '접기', style, children }: {
  title: ReactNode; summary?: ReactNode; count?: number; defaultOpen?: boolean;
  open?: boolean; onToggle?: (open: boolean) => void;
  openLabel?: string; closeLabel?: string; style?: CSSProperties; children: ReactNode;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => { const next = !open; if (openProp == null) setOpenState(next); onToggle?.(next); };
  return (
    <div style={style}>
      <button
        type="button"
        className="btn ghost"
        aria-expanded={open}
        onClick={toggle}
        style={{ justifyContent: 'space-between', textAlign: 'left', border: 'none', padding: '0.4rem 0.2rem', minHeight: 56, gap: '0.6rem', borderRadius: 12 }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 800, overflowWrap: 'anywhere' }}>{title}{count != null && <span className="badge neutral" style={{ marginLeft: '0.4rem' }}>{count}개</span>}</span>
          {summary != null && !open && <span className="small muted" style={{ display: 'block', fontWeight: 700, marginTop: '0.1rem', overflowWrap: 'anywhere' }}>{summary}</span>}
        </span>
        <span className="small muted" style={{ flex: 'none', whiteSpace: 'nowrap', fontWeight: 800 }}>{open ? `▾ ${closeLabel}` : `▸ ${openLabel}`}</span>
      </button>
      {open && <div style={{ marginTop: '0.3rem' }}>{children}</div>}
    </div>
  );
}

/**
 * 긴 목록을 처음 N개만 보여주고 "더 보기 (N개 남음)" 버튼(≥56px)으로 step 씩 늘린다. 다 펼치면 "접기".
 * renderItem 은 한 줄씩, render 는 보이는 만큼을 한꺼번에(날짜별 묶기처럼 목록 전체가 필요할 때).
 */
export function ShowMore<T>({ items, renderItem, render, initial = 5, step = 10, label = '더 보기' }: {
  items: T[]; renderItem?: (item: T, index: number) => ReactNode; render?: (visible: T[]) => ReactNode;
  initial?: number; step?: number; label?: string;
}) {
  const [shown, setShown] = useState(initial);
  const n = Math.min(shown, items.length);
  const visible = items.slice(0, n);
  const remaining = items.length - n;
  return (
    <>
      {render ? render(visible) : visible.map((it, i) => renderItem?.(it, i))}
      {remaining > 0 && (
        <button type="button" className="btn small" style={{ marginTop: '0.5rem' }} onClick={() => setShown(n + step)}>▾ {label} ({remaining}개 남음)</button>
      )}
      {remaining === 0 && items.length > initial && (
        <button type="button" className="btn small ghost" style={{ marginTop: '0.5rem' }} onClick={() => setShown(initial)}>▴ 접기 (처음 {initial}개만)</button>
      )}
    </>
  );
}
