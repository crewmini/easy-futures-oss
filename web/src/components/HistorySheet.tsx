import { useEffect, useMemo, useState } from 'react';
import type { DailyPnl, HistorySummary, TradeHistoryItem, TradeHistoryResponse } from '@easy-futures/shared';
import { SYMBOL_LABEL } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { fmtCoin, fmtKrw, fmtPrice, fmtSigned, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';

const KIND_LABEL: Record<TradeHistoryItem['kind'], string> = {
  open: '진입',
  close: '직접 정리',
  sl: '손절 (자동 정리)',
  tp: '익절 (자동 정리)',
  auto: '자동 정리',
  liq: '강제정리',
};

type SourceFilter = 'all' | 'manual' | 'auto' | 'copy';
const SOURCE_LABEL: Record<SourceFilter, string> = { all: '전체', manual: '쉬운 거래', auto: 'AI 자동매매', copy: '고수 따라하기' };
const ZERO: HistorySummary = { realizedPnl: 0, totalFees: 0, netPnl: 0, closedCount: 0 };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');
/** ms → KST 날짜 키 (YYYY-MM-DD). 서버의 daily[].date 와 같은 규칙. */
function kstKey(ms: number): string {
  const d = new Date(ms + KST_OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** 'YYYY-MM-DD' → '2026년 9월 8일 (화)' */
function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${dow})`;
}
function matchesSource(it: TradeHistoryItem, f: SourceFilter): boolean {
  if (f === 'all') return true;
  if (f === 'manual') return it.source === 'manual' || !it.source;
  if (f === 'copy') return it.source === 'copy';
  return it.source === 'auto' || it.source === 'mixed';
}
/** 달력 칸용 짧은 숫자: 소수 2자리, 끝 0 제거, 100 이상은 정수. 예) +1.2 / -0.06 / +1234 */
/** 달력 칸용 짧은 숫자: 100 이상 정수, 1 이상 소수 1자리, 그 밑은 소수 2자리(끝 0 제거) — 375px 칸(약 45px)에 들어가야 한다 */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  const r = a >= 100 ? Math.round(v) : a >= 1 ? Number(v.toFixed(1)) : Number(v.toFixed(2));
  return (r > 0 ? '+' : '') + String(r);
}
const signCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** 거래 내역: 날짜별로 묶어 한 줄에 한 거래. 어르신용 큰 글씨. */
export function HistorySheet({ usdtKrw, onClose }: { usdtKrw: number; onClose: () => void }) {
  const [data, setData] = useState<TradeHistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [source, setSource] = useState<SourceFilter>('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    api.history(days).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e instanceof ApiError ? e.message : '내역을 불러오지 못했어요'); });
    return () => { alive = false; };
  }, [days]);

  const items = useMemo(() => (data?.items ?? []).filter((it) => matchesSource(it, source)), [data, source]);
  const shown = selectedDay ? items.filter((it) => kstKey(it.time) === selectedDay) : items;
  const groups = groupByDay(shown);

  const summary: HistorySummary | null = data ? (source === 'all' ? data : data.bySource[source] ?? ZERO) : null;   // copy 합계는 옛 서버에 없을 수 있다 → 0
  const pnlCls = summary ? signCls(summary.netPnl) : '';

  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>거래 내역</h2></div>
      <div className="seg seg3" style={{ marginBottom: '0.5rem' }}>
        {[7, 30, 90].map((d) => <button key={d} className={`btn ${days === d ? 'selected' : ''}`} onClick={() => { setDays(d); setSelectedDay(null); }}>최근 {d}일</button>)}
      </div>
      <div className="seg seg4" style={{ marginBottom: '0.8rem' }} role="group" aria-label="거래 출처">
        {(['all', 'manual', 'auto', 'copy'] as SourceFilter[]).map((s) => <button key={s} className={`btn ${source === s ? 'selected' : ''}`} onClick={() => setSource(s)}>{SOURCE_LABEL[s]}</button>)}
      </div>
      {data && summary && (
        <div className="card">
          <h2>최근 {data.days}일 요약{source !== 'all' ? ` · ${SOURCE_LABEL[source]}` : ''}</h2>
          <div className="kv"><span className="k">손익 (이 기간)</span><span className={`v ${pnlCls}`}>{fmtSigned(summary.netPnl)} USDT<br /><span className="small">≈ {summary.netPnl < 0 ? '-' : ''}{fmtKrw(Math.abs(summary.netPnl), usdtKrw)}</span></span></div>
          <div className="kv"><span className="k">정리한 횟수</span><span className="v">{summary.closedCount}번</span></div>
          {source === 'all' && (
            <>
              <div className="kv compact"><span className="k">AI 자동매매 순손익</span><span className={`v ${signCls(data.bySource.auto.netPnl)}`}>{fmtSigned(data.bySource.auto.netPnl)} USDT <span className="small muted">· {data.bySource.auto.closedCount}번</span></span></div>
              <div className="kv compact"><span className="k">쉬운 거래 순손익</span><span className={`v ${signCls(data.bySource.manual.netPnl)}`}>{fmtSigned(data.bySource.manual.netPnl)} USDT <span className="small muted">· {data.bySource.manual.closedCount}번</span></span></div>
              {data.bySource.copy && <div className="kv compact"><span className="k">고수 따라하기 순손익</span><span className={`v ${signCls(data.bySource.copy.netPnl)}`}>{fmtSigned(data.bySource.copy.netPnl)} USDT <span className="small muted">· {data.bySource.copy.closedCount}번</span></span></div>}
            </>
          )}
        </div>
      )}
      {data && (
        <Calendar daily={data.daily} days={data.days} source={source} items={items} selectedDay={selectedDay} onSelect={setSelectedDay} />
      )}
      {err && <div className="banner err">{err}</div>}
      {!data && !err && <div className="empty">불러오는 중…</div>}
      {data && shown.length === 0 && (
        <div className="empty">{data.items.length === 0 ? '이 기간에는 거래가 없어요.' : selectedDay ? `${dayLabel(selectedDay)}에는 ${source === 'all' ? '' : SOURCE_LABEL[source] + ' '}거래가 없어요.` : `${SOURCE_LABEL[source]} 거래가 없어요.`}</div>
      )}
      {groups.map(([day, list]) => (
        <div className="card" key={day}>
          <h2>{dayLabel(day)}</h2>
          {list.map((it) => <Row key={it.id} it={it} usdtKrw={usdtKrw} />)}
        </div>
      ))}
    </div></div>
  );
}

/** 월별 달력: 정리한 날에 순손익을 짧게 보여주고, 날을 누르면 그 날만 본다. 날짜는 모두 KST. */
function Calendar({ daily, days, source, items, selectedDay, onSelect }: {
  daily: DailyPnl[]; days: number; source: SourceFilter; items: TradeHistoryItem[]; selectedDay: string | null; onSelect: (d: string | null) => void;
}) {
  const todayKey = kstKey(Date.now());
  const startKey = kstKey(Date.now() - days * DAY_MS);
  // 불러온 기간에 걸친 달 목록 (YYYY-MM)
  const months = useMemo(() => {
    const out: string[] = [];
    let [y, m] = startKey.split('-').map(Number);
    const [ey, em] = todayKey.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m)}`); m += 1; if (m > 12) { m = 1; y += 1; } }
    return out;
  }, [startKey, todayKey]);
  const [month, setMonth] = useState(todayKey.slice(0, 7));
  const cur = months.includes(month) ? month : months[months.length - 1];
  const idx = months.indexOf(cur);

  // 날짜별 값: 전체 → netPnl, 출처 필터 → daily.auto / daily.manual. 횟수는 필터 시 목록에서 센다.
  const byDate = useMemo(() => {
    const map = new Map<string, { v: number; n: number }>();
    // daily 에는 auto/manual 만 있다 — 고수 따라하기는 목록의 순손익을 날짜별로 더한다
    for (const d of daily) map.set(d.date, { v: source === 'all' ? d.netPnl : source === 'auto' ? d.auto : source === 'manual' ? d.manual : 0, n: source === 'all' ? d.closedCount : 0 });
    if (source !== 'all') {
      for (const it of items) {
        if (it.kind === 'open') continue;
        const k = kstKey(it.time);
        const e = map.get(k) ?? { v: 0, n: 0 };
        e.n += 1; if (source === 'copy') e.v += it.netPnl ?? 0; map.set(k, e);
      }
    }
    return map;
  }, [daily, source, items]);

  const [y, m] = cur.split('-').map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0, count = 0;
  for (const [k, e] of byDate) { if (k.startsWith(cur) && e.n > 0) { total += e.v; count += e.n; } }
  const totalCls = signCls(total);
  // 누른 날의 정확한 숫자 — 칸 안 글자가 작거나(아주 크게에서는 ▲/▼만) 안 보일 때를 위해 아래 줄에 크게
  const selected = selectedDay ? byDate.get(selectedDay) ?? { v: 0, n: 0 } : null;

  const cells: (number | null)[] = [...Array<null>(firstDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  return (
    <div className="card cal">
      <div className="cal-head">
        <button className="btn small" aria-label="이전 달" disabled={idx <= 0} onClick={() => setMonth(months[idx - 1])}>‹</button>
        <div className="cal-title">{y}년 {m}월</div>
        <button className="btn small" aria-label="다음 달" disabled={idx >= months.length - 1} onClick={() => setMonth(months[idx + 1])}>›</button>
      </div>
      <div className="cal-grid">
        {DOW.map((d, i) => <div key={d} className={`cal-dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}`}>{d}</div>)}
        {cells.map((d, i) => {
          if (d == null) return <div key={`e${i}`} />;
          const key = `${cur}-${pad(d)}`;
          const e = byDate.get(key);
          const hit = e && e.n > 0 ? e : null;
          const out = key < startKey || key > todayKey;
          const c = hit ? signCls(hit.v) : '';
          return (
            <button key={key} type="button" disabled={out}
              className={`cal-cell ${hit ? (c === 'up' ? 'gain' : c === 'down' ? 'loss' : 'flat') : ''} ${selectedDay === key ? 'selected' : ''} ${key === todayKey ? 'today' : ''}`}
              aria-pressed={selectedDay === key}
              aria-label={`${m}월 ${d}일${hit ? ` 순손익 ${fmtSigned(hit.v)} USDT, 정리 ${hit.n}번` : ''}`}
              onClick={() => onSelect(selectedDay === key ? null : key)}>
              <span className="d">{d}</span>
              {/* 숫자는 보통·크게 글자에서, 아주 크게에서는 ▲/▼ 표시만 (CSS 로 전환) */}
              {hit && <span className={`p ${c}`}>{fmtCompact(hit.v)}</span>}
              {hit && <span className={`pm ${c}`} aria-hidden="true">{c === 'up' ? '▲' : c === 'down' ? '▼' : '●'}</span>}
            </button>
          );
        })}
      </div>
      <div className="cal-total">이 달 순손익 <b className={totalCls}>{fmtSigned(total)} USDT</b> · 정리 {count}번</div>
      {selected && (
        <div className="cal-total" style={{ marginTop: '0.2rem' }}>{dayLabel(selectedDay!)} 순손익 <b className={signCls(selected.v)}>{fmtSigned(selected.v)} USDT</b> · 정리 {selected.n}번</div>
      )}
      {selectedDay && (
        <button className="btn small" style={{ marginTop: '0.5rem' }} onClick={() => onSelect(null)}>{dayLabel(selectedDay)}만 보는 중 — 전체 기간 보기</button>
      )}
      {!selectedDay && <div className="hint" style={{ marginTop: '0.3rem' }}>날짜를 누르면 그 날 거래만 볼 수 있어요.</div>}
    </div>
  );
}

function SourceBadge({ source }: { source: TradeHistoryItem['source'] }) {
  if (source === 'auto') return <span className="badge ok">AI 자동매매</span>;
  if (source === 'copy') return <span className="badge copy">고수 따라하기</span>;
  if (source === 'mixed') return <span className="badge warn">혼합</span>;
  return <span className="badge neutral">쉬운 거래</span>;
}

function Row({ it, usdtKrw }: { it: TradeHistoryItem; usdtKrw: number }) {
  const [open, setOpen] = useState(false);
  const label = SYMBOL_LABEL[it.symbol];
  const isOpen = it.kind === 'open';
  const dirWord = it.direction === 'long' ? '오른다' : '내린다';
  const net = it.netPnl ?? null;
  const pnlCls = net == null ? '' : net > 0 ? 'up' : net < 0 ? 'down' : '';
  const time = new Date(it.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });
  return (
    <div>
      <div className="kv" style={{ alignItems: 'center', gap: '0.5rem', cursor: isOpen ? 'default' : 'pointer', borderBottom: open ? 'none' : undefined }} onClick={() => { if (!isOpen) setOpen((v) => !v); }} onKeyDown={(e) => { if (!isOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }} tabIndex={isOpen ? undefined : 0} role={isOpen ? undefined : 'button'} aria-expanded={isOpen ? undefined : open}>
        <CoinLogo symbol={it.symbol} size={30} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="hist-title">
            <span>{label.name}</span>
            <span className={`badge ${it.direction === 'long' ? 'up' : 'down'}`}>{dirWord}</span>
            <SourceBadge source={it.source} />
          </div>
          <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>{KIND_LABEL[it.kind]}{it.kind === 'liq' && <span className="badge warn" style={{ marginLeft: '0.3rem' }}>주의</span>}</div>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{time} · {fmtPrice(it.price)} 달러 · {fmtCoin(it.coinAmount, label.coin)}{it.leverage ? ` · ${it.leverage}배` : ''}</div>
        </div>
        {/* 오른쪽 칸은 절반까지만 쓰고 줄바꿈 — 큰 글자에서 왼쪽 글이 밀려나지 않게 */}
        <div style={{ textAlign: 'right', flex: '0 1 auto', maxWidth: '50%', overflowWrap: 'anywhere' }}>
          {isOpen ? (
            it.fee != null && it.fee > 0 ? <div className="small muted">수수료 {fmtUsdt(it.fee, 4)}</div> : null
          ) : (
            <>
              <div className={`v ${pnlCls}`} style={{ fontWeight: 900 }}>{net == null ? '—' : `${fmtSigned(net)} USDT`}</div>
              {net != null && <div className={`small ${pnlCls}`}>{net < 0 ? '-' : ''}{fmtKrw(Math.abs(net), usdtKrw)}</div>}
              <div className="small muted">순손익 {open ? '▲' : '▼'}</div>
            </>
          )}
        </div>
      </div>
      {open && !isOpen && (
        <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '0.5rem 0.8rem', margin: '0 0 0.5rem', fontSize: '0.9rem' }}>
          <div className="kv"><span className="k">진입 수수료</span><span className="v" style={{ fontSize: '0.95rem' }}>-{fmtUsdt(it.openFee ?? 0, 4)} USDT</span></div>
          <div className="kv"><span className="k">정리 수수료</span><span className="v" style={{ fontSize: '0.95rem' }}>-{fmtUsdt(it.fee ?? 0, 4)} USDT</span></div>
          <div className="kv"><span className="k">순손익</span><span className={`v ${pnlCls}`} style={{ fontSize: '0.95rem' }}>{net == null ? '—' : `${fmtSigned(net)} USDT`}</span></div>
        </div>
      )}
    </div>
  );
}

/** KST 날짜 키(YYYY-MM-DD)로 묶는다 — 달력과 같은 날짜 규칙. */
function groupByDay(items: TradeHistoryItem[]): [string, TradeHistoryItem[]][] {
  const map = new Map<string, TradeHistoryItem[]>();
  for (const it of items) {
    const key = kstKey(it.time);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return [...map.entries()];
}
