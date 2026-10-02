import { useRef, useState } from 'react';
import { vibrate } from '../lib/format';

/** 손가락이 버튼 밖으로 이 거리(px)보다 더 나가야 취소. 어르신 손 떨림·살짝 밀림에는 계속 진행 */
const LEAVE_SLACK = 24;

/** 길게 눌러야 실행되는 버튼. 실수 방지용. */
export function HoldButton({ label, holdMs = 1500, className = 'btn primary', onConfirm, disabled, busy, busyLabel = '보내는 중… 잠시만요' }: {
  label: string; holdMs?: number; className?: string; onConfirm: () => void; disabled?: boolean; busy?: boolean; busyLabel?: string;
}) {
  const [pct, setPct] = useState(0);
  const timer = useRef<number>();
  const start = useRef<number>(0);
  const done = useRef(false);

  // rAF는 화면이 가려지면 멈추므로 setInterval 사용
  const tick = () => {
    const p = Math.min(1, (Date.now() - start.current) / holdMs);
    setPct(p);
    if (p >= 1) { window.clearInterval(timer.current); if (!done.current) { done.current = true; vibrate([30, 40, 60]); onConfirm(); } }
  };
  const begin = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (disabled) return;
    done.current = false; start.current = Date.now(); vibrate(15);
    window.clearInterval(timer.current);
    timer.current = window.setInterval(tick, 50);
  };
  const end = () => { window.clearInterval(timer.current); timer.current = undefined; setPct(0); };
  // 포인터를 잡아 두면(capture) 버튼 밖으로 살짝 나가도 move/up 이 계속 이 버튼으로 온다
  const beginPointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 지원 안 하는 브라우저 */ }
    begin(e);
  };
  const farOutside = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left - LEAVE_SLACK || e.clientX > r.right + LEAVE_SLACK || e.clientY < r.top - LEAVE_SLACK || e.clientY > r.bottom + LEAVE_SLACK;
  };
  const maybeEnd = (e: React.PointerEvent<HTMLButtonElement>) => { if (timer.current != null && farOutside(e)) end(); };

  return (
    <button className={`btn hold ${className}`} disabled={disabled || busy} aria-label={`${label} (1.5초 동안 길게 누르세요)`}
      onPointerDown={beginPointer} onPointerUp={end} onPointerCancel={end} onPointerMove={maybeEnd} onPointerLeave={maybeEnd} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) begin(e); }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') end(); }}>
      <span className="fill" style={{ width: `${pct * 100}%` }} />
      <span className="label">{busy ? busyLabel : pct > 0 && pct < 1 ? '계속 누르고 계세요…' : label}</span>
    </button>
  );
}
