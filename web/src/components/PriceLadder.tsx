import { useEffect, useRef, useState } from 'react';
import type { Position } from '@easy-futures/shared';
import { fmtPrice } from '../lib/format';

/**
 * 가격 게이지(온도계형). 위가 높은 가격.
 * - 트랙 구간: 평단↔익절 = 이익 구간(옅은 빨강), 평단↔손절 = 손실 구간(옅은 파랑), 손절↔강제정리 = 위험 구간(옅은 주황)
 * - 채움 막대: 평단에서 지금 가격까지 (이익 빨강 / 손해 파랑)
 * - 지금 가격은 트랙 왼쪽의 알약 라벨, 시세 따라 미끄러진다. 오른쪽 라벨에는 "얼마나 남았는지"를 함께 적는다.
 */
export function PriceLadder({ pos }: { pos: Position }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setReady(true), 60); return () => window.clearTimeout(t); }, []);

  // ▲/▼ 틱 표시
  const prev = useRef<number>(pos.markPrice);
  const [tick, setTick] = useState<{ dir: 'up' | 'down'; id: number } | null>(null);
  useEffect(() => {
    if (pos.markPrice !== prev.current) { setTick({ dir: pos.markPrice > prev.current ? 'up' : 'down', id: Date.now() }); prev.current = pos.markPrice; }
  }, [pos.markPrice]);

  const entry = pos.entryPrice, now = pos.markPrice, tp = pos.takeProfitPrice, sl = pos.stopLossPrice, liq = pos.liquidationPrice;
  const isLong = pos.direction === 'long';
  const profit = pos.unrealizedPnl >= 0;

  // 손절/익절까지 진행률 (0=평단, 1=도달)
  const progress = (target: number | null) => {
    if (!target) return 0;
    const total = Math.abs(target - entry); if (total <= 0) return 0;
    const towards = (target > entry) === (now > entry);
    return towards ? Math.min(1, Math.abs(now - entry) / total) : 0;
  };
  const nearSl = progress(sl) >= 0.7, nearTp = progress(tp) >= 0.7;

  // 눈금 범위
  const pts = [entry, now, tp, sl, liq].filter((v): v is number => !!v && v > 0);
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = (hi - lo || entry * 0.02) * 0.14;
  const min = lo - pad, max = hi + pad;
  const y = (p: number) => 100 - ((p - min) / (max - min)) * 100;
  const seg = (a: number, b: number) => ({ top: `${Math.min(y(a), y(b))}%`, height: `${Math.abs(y(a) - y(b))}%` });

  // 오른쪽 라벨(겹침 방지)
  type L = { key: string; name: string; price: number; cls: string; sub?: string; y: number };
  const labels: L[] = [{ key: 'entry', name: '산 가격(평단)', price: entry, cls: 'entry', y: y(entry) }];
  const dist = (target: number) => `${fmtPrice(Math.round(Math.abs(target - now)))} 남음`; // 짧게 — 아주 큰 글자에서도 카드 안에 들어가게
  if (tp) labels.push({ key: 'tp', name: '익절가', price: tp, cls: `tp ${nearTp ? 'hot' : ''}`, sub: nearTp ? '거의 다 왔어요' : dist(tp), y: y(tp) });
  if (sl) labels.push({ key: 'sl', name: '손절가', price: sl, cls: `sl ${nearSl ? 'danger' : ''}`, sub: nearSl ? '가까워요!' : dist(sl), y: y(sl) });
  if (liq) labels.push({ key: 'liq', name: '강제정리가', price: liq, cls: 'liq', y: y(liq) });
  labels.sort((a, b) => a.y - b.y);
  const GAP = 15;
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < GAP) labels[i].y = labels[i - 1].y + GAP;
  // 트랙 안에 머물도록 위·아래 여유 확보 (8% ~ 88%) — 라벨(최대 3줄) 절반 높이가 게이지의 약 8%
  if (labels.length && labels[0].y < 8) { const d = 8 - labels[0].y; labels.forEach((l) => { l.y += d; }); }
  const over = labels.length ? labels[labels.length - 1].y - 88 : 0;
  if (over > 0) labels.forEach((l) => { l.y -= over * (l.y / 100); });

  const fill = ready ? seg(entry, now) : { top: `${y(entry)}%`, height: '0%' };

  return (<>
    <div className={`gauge ${nearSl ? 'near-sl' : ''} ${nearTp ? 'near-tp' : ''}`} aria-label="가격 게이지">
      <div className="g-track">
        {tp && <div className="g-seg profit" style={seg(entry, tp)} />}
        {sl && <div className="g-seg loss" style={seg(entry, sl)} />}
        {sl && liq && <div className="g-seg danger" style={seg(sl, liq)} />}
        {!sl && liq && <div className="g-seg danger" style={seg(entry, liq)} />}
        <div className={`g-fill ${profit ? 'up' : 'down'}`} style={fill} />
        <div className="g-line entry" style={{ top: `${y(entry)}%` }} />
        {tp && <div className={`g-tick tp ${nearTp ? 'hot' : ''}`} style={{ top: `${y(tp)}%` }} />}
        {sl && <div className={`g-tick sl ${nearSl ? 'danger' : ''}`} style={{ top: `${y(sl)}%` }} />}
        {liq && <div className="g-tick liq" style={{ top: `${y(liq)}%` }} />}
      </div>

      {/* 지금 가격 알약: 트랙 왼쪽, 시세 따라 이동 */}
      <div className={`g-now ${profit ? 'up' : 'down'} ${ready ? 'in' : ''}`} style={{ top: `${y(now)}%` }}>
        <span className="g-now-name">지금</span>
        <span key={Math.round(now * 10)} className="g-now-price">{fmtPrice(now)}</span>
        {tick && <span key={tick.id} className={`g-arrow ${tick.dir}`}>{tick.dir === 'up' ? '▲' : '▼'}</span>}
        <span className="g-now-tip" />
      </div>

      {labels.map((l, i) => (
        <div key={l.key} className={`g-label ${l.cls}`} style={{ top: `${l.y}%`, animationDelay: `${0.25 + i * 0.08}s` }}>
          <span className="g-label-name">{l.name}</span>
          <span className="g-label-price">{fmtPrice(l.price)}</span>
          {l.sub && <span className="g-label-sub">{l.sub}</span>}
        </div>
      ))}
    </div>
    <div className="g-legend">{isLong ? '위로 갈수록 이익' : '아래로 갈수록 이익'} · 지금 팔면 {profit ? '이익' : '손해'}</div>
  </>);
}
