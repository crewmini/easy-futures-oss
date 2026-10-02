import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, PartnerMember } from '@easy-futures/shared';
import { SYMBOL_LABEL } from '@easy-futures/shared';
import { api, ApiError } from '../lib/api';
import { fmtCoin, fmtPct, fmtPrice, fmtSigned, fmtUsdt } from '../lib/format';
import { CoinLogo } from './CoinLogo';
import { useToast } from './Toast';

const POLL_MS = 30_000;

/** 제휴사 페이지: 내 제휴 코드, 고객 목록과 실시간 포지션, UID 로 고객 추가 */
export function PartnerSheet({ me, onClose }: { me: Me; onClose: () => void }) {
  const toast = useToast();
  const [members, setMembers] = useState<PartnerMember[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [uid, setUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number>();
  const loading = useRef(false);
  const [filter, setFilter] = useState<'all' | 'open' | 'risk'>('all');

  const load = useCallback(async () => {
    if (loading.current) return; // 이전 요청이 끝나기 전엔 겹치지 않게
    loading.current = true;
    try { const r = await api.partnerMembers(); setMembers(r.members); setUpdatedAt(r.serverTime); setErr(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '불러오지 못했어요'); }
    finally { loading.current = false; }
  }, []);
  useEffect(() => {
    void load();
    timer.current = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => window.clearInterval(timer.current);
  }, [load]);

  const add = async () => {
    setBusy(true);
    try { const r = await api.partnerAddMember(uid.trim()); toast(`${r.loginId} 님을 내 고객으로 연결했어요`); setUid(''); await load(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '추가하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(me.affiliateCode ?? ''); toast('제휴 코드를 복사했어요'); } catch { toast('길게 눌러 복사해 주세요', 'err'); } };

  const open = (members ?? []).filter((m) => m.positions.length > 0);
  const riskOf = (m: PartnerMember) => Math.max(0, ...m.positions.map((p) => liqProgress(p)));
  const risky = open.filter((m) => riskOf(m) >= 0.5);
  const shown = [...(members ?? [])]
    .filter((m) => filter === 'all' ? true : filter === 'open' ? m.positions.length > 0 : riskOf(m) >= 0.5)
    .sort((a, b) => riskOf(b) - riskOf(a) || b.positions.length - a.positions.length);
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>제휴사 페이지</h2></div>

      <div className="card">
        <h2>내 제휴 코드</h2>
        <div className="row">
          <span className="huge" style={{ fontSize: '1.8rem', letterSpacing: '0.04em' }}>{me.affiliateCode}</span>
          <button className="btn small" style={{ width: 'auto' }} onClick={copy}>복사</button>
        </div>
        <div className="hint">고객이 가입할 때 "제휴 코드" 칸에 이 코드를 넣으면 자동으로 연결돼요.</div>
      </div>

      <div className="card">
        <h2>코드 없이 가입한 고객 연결</h2>
        <div className="row">
          <input className="num" style={{ textAlign: 'left', fontSize: '1.1rem' }} inputMode="numeric" maxLength={8} placeholder="UID 91231234" value={uid} onChange={(e) => setUid(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))} />
          <button className="btn primary" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={busy || !/^9\d{7}$/.test(uid)} onClick={add}>추가</button>
        </div>
      </div>

      <div style={{ margin: '0.2rem 0 0.6rem' }}>
        <div style={{ fontWeight: 900, fontSize: '1.2rem' }}>내 고객 {members ? members.length : '—'}명 <span className="small muted">· 포지션 있음 {open.length}명 · 위험 {risky.length}명</span></div>
        <div className="row"><span className="small muted">{updatedAt ? new Date(updatedAt).toLocaleTimeString('ko-KR') + ' 갱신 · 30초마다 자동' : ''}</span><button className="btn small ghost" style={{ width: 'auto' }} onClick={() => void load()}>지금 새로고침</button></div>
      </div>
      <div className="seg seg3" style={{ marginBottom: '0.6rem' }}>
        <button className={`btn ${filter === 'all' ? 'selected' : ''}`} onClick={() => setFilter('all')}>전체</button>
        <button className={`btn ${filter === 'open' ? 'selected' : ''}`} onClick={() => setFilter('open')}>포지션 있음</button>
        <button className={`btn ${filter === 'risk' ? 'selected' : ''}`} onClick={() => setFilter('risk')}>⚠️ 위험</button>
      </div>
      {err && <div className="banner err">{err}</div>}
      {members && members.length === 0 && <div className="empty">아직 연결된 고객이 없어요.</div>}
      {members && shown.length === 0 && members.length > 0 && <div className="empty">해당하는 고객이 없어요.</div>}
      {shown.map((m) => <MemberCard key={m.userId} m={m} onRemove={async () => { if (!window.confirm(`${m.loginId} 님을 내 고객 목록에서 뺄까요?`)) return; try { await api.partnerRemoveMember(m.userId); await load(); } catch { toast('실패', 'err'); } }} />)}
    </div></div>
  );
}

/** 평단→강제정리가 사이에서 지금 가격이 얼마나 갔는지 (0=평단, 1=강제정리) */
function liqProgress(p: { entryPrice: number; markPrice: number; liquidationPrice: number | null; direction: 'long' | 'short' }): number {
  if (!p.liquidationPrice) return 0;
  const total = Math.abs(p.liquidationPrice - p.entryPrice);
  if (total <= 0) return 0;
  const towards = (p.liquidationPrice > p.entryPrice) === (p.markPrice > p.entryPrice);
  return towards ? Math.min(1, Math.abs(p.markPrice - p.entryPrice) / total) : 0;
}

function MemberCard({ m, onRemove }: { m: PartnerMember; onRemove: () => void }) {
  const joined = new Date(m.joinedAt).toLocaleDateString('ko-KR');
  const kyc = m.kycStatus === 'approved' ? '인증 완료' : m.kycStatus === 'pending' ? '인증 확인 중' : m.kycStatus === 'rejected' ? '인증 거절' : '미인증';
  return (
    <div className="card">
      <div className="row">
        <div>
          <div style={{ fontWeight: 900, fontSize: '1.1rem' }}>{m.loginId} <span className={`badge ${m.mode === 'live' ? 'live' : 'ok'}`}>{m.mode === 'live' ? '실거래' : '연습 엔진'}</span>{m.autoStatus === 'approved' && <span className="badge ok" style={{ marginLeft: '0.3rem' }}>AI 자동매매</span>}{m.autoStatus === 'pending' && <span className="badge warn" style={{ marginLeft: '0.3rem' }}>AI 신청 중</span>}</div>
          <div className="small muted">UID {m.uid ?? '—'} · {kyc} · 가입 {joined}{m.error ? ` · ${m.error}` : ''}</div>
        </div>
        <button className="btn small ghost" style={{ width: 'auto' }} onClick={onRemove}>빼기</button>
      </div>
      {m.wallet && (
        <div className="kv"><span className="k">지갑</span><span className="v">{fmtUsdt(m.wallet.equity)} USDT <span className="small muted">(쓸 수 있는 돈 {fmtUsdt(m.wallet.available)})</span></span></div>
      )}
      {m.positions.length === 0 ? (
        <div className="small muted" style={{ padding: '0.4rem 0' }}>지금 잡은 포지션 없음</div>
      ) : m.positions.map((p) => {
        const cls = p.unrealizedPnl > 0 ? 'up' : p.unrealizedPnl < 0 ? 'down' : '';
        return (
          <div key={p.symbol} style={{ borderTop: '1px dashed var(--line)', padding: '0.5rem 0' }}>
            <div style={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
              <CoinLogo symbol={p.symbol} size={22} /> <span style={{ whiteSpace: 'nowrap' }}>{SYMBOL_LABEL[p.symbol].name}</span>
              <span className={`badge ${p.direction === 'long' ? 'up' : 'down'}`} style={{ whiteSpace: 'nowrap' }}>{p.direction === 'long' ? '오른다' : '내린다'}</span>
              <span className="badge warn" style={{ whiteSpace: 'nowrap' }}>{p.leverage}배</span>
            </div>
            <div className={`${cls}`} style={{ fontWeight: 900, fontSize: '1.15rem', margin: '0.15rem 0' }}>{fmtSigned(p.unrealizedPnl)} USDT <span className="small">({fmtPct(p.unrealizedPct)})</span></div>
            <div className="small muted">진입 {fmtPrice(p.entryPrice)} · 지금 {fmtPrice(p.markPrice)} · {fmtCoin(p.coinAmount, SYMBOL_LABEL[p.symbol].coin)} · 걸어둔 돈 {fmtUsdt(p.marginUsdt)} USDT</div>
            <div className="small">손절 <b className="down">{p.stopLossPrice ? fmtPrice(p.stopLossPrice) : '없음 ⚠️'}</b> · 익절 <b className="up">{p.takeProfitPrice ? fmtPrice(p.takeProfitPrice) : '없음'}</b> · 강제정리 <b style={{ color: 'var(--warn)' }}>{fmtPrice(p.liquidationPrice)}</b></div>
            {p.liquidationPrice && (() => { const prog = liqProgress(p); const distPct = Math.abs(p.liquidationPrice - p.markPrice) / p.markPrice * 100; return (
              <div className={`small ${prog >= 0.5 ? '' : 'muted'}`} style={{ fontWeight: 800, color: prog >= 0.5 ? 'var(--warn)' : undefined }}>
                강제정리까지 {distPct.toFixed(2)}% 남음{prog >= 0.7 ? ' · 🚨 매우 가까워요' : prog >= 0.5 ? ' · ⚠️ 가까워요' : ''}
              </div>); })()}
          </div>
        );
      })}
    </div>
  );
}
