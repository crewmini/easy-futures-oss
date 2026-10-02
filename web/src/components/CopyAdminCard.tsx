import { useState } from 'react';
import type { AdminCopyMaster, AdminCopyResponse } from '@easy-futures/shared';
import { SYMBOL_LABEL } from '@easy-futures/shared';
import { api } from '../lib/api';
import { fmtPrice, fmtUsdt } from '../lib/format';
import { useToast } from './Toast';
import { PnlWord, STOP_REASON, closeReasonLabel, copyErrMsg, fmtWhen, kindLabel } from './CopyCommon';
import { AdminRow, Disclosure, EmptyLine, LoadSlot, MoreToggle, SectionHead, TabLink, type Loaded } from './AdminCommon';

const RESET_LABEL = { roi: '30일 수익률', winRate: '승률·거래 수', recent: '최근 마감 거래', all: '통계 전부' } as const;
const EVENTS_SHOWN = 5;

/** 카피 트레이딩 관리자 동작 묶음 — 승인 탭(신청 승인/거절)과 고수 탭이 같이 쓴다 */
export function useCopyAdminActions(reload: () => Promise<void>) {
  const toast = useToast();
  const decide = async (m: AdminCopyMaster, action: 'approve' | 'reject' | 'suspend') => {
    const note = action !== 'approve' ? (window.prompt('사유 (고수에게 보여요)', action === 'suspend' ? '확인이 필요해 잠시 중지했어요' : '이번에는 승인하지 않았어요') ?? undefined) : undefined;
    if (action !== 'approve' && note === undefined) return;
    if (action === 'suspend' && !window.confirm(`${m.nickname} (${m.loginId}) 고수를 중지할까요? 팔로워 ${m.followers}명의 따라하기가 모두 멈춰요 (포지션은 남아요).`)) return;
    try { await api.adminCopyMasterDecide(m.userId, action, note); toast(action === 'approve' ? '고수를 승인했어요' : action === 'suspend' ? '중지했어요' : '거절했어요'); await reload(); }
    catch (e) { toast(copyErrMsg(e, '실패'), 'err'); }
  };
  const resetStats = async (m: AdminCopyMaster, which: keyof typeof RESET_LABEL) => {
    if (!window.confirm(`${m.nickname} 고수의 "${RESET_LABEL[which]}"를 초기화할까요? 지금 이후의 마감 거래부터 새로 집계돼요. 되돌릴 수 없어요.`)) return;
    try { await api.adminCopyResetStats(m.userId, which); toast(`${RESET_LABEL[which]} 초기화했어요`); await reload(); }
    catch (e) { toast(copyErrMsg(e, '초기화하지 못했어요'), 'err'); }
  };
  const pauseGlobal = async (next: boolean) => {
    if (!window.confirm(next ? '모든 고수의 새 진입을 멈출까요? (정리·손절 변경·손실 한도는 계속 동작해요)' : '전체 멈춤을 풀까요? 새 진입이 다시 복제돼요.')) return;
    try { await api.adminCopyPauseGlobal(next); toast(next ? '전체 새 진입을 멈췄어요' : '전체 멈춤을 풀었어요'); await reload(); } catch (e) { toast(copyErrMsg(e, '바꾸지 못했어요'), 'err'); }
  };
  const pauseMaster = async (m: AdminCopyMaster, next: boolean) => {
    if (!window.confirm(next ? `${m.nickname} 고수의 새 진입만 멈출까요? 팔로워는 유지되고 정리·손절 변경은 계속 따라가요.` : `${m.nickname} 고수의 멈춤을 풀까요?`)) return;
    try { await api.adminCopyPauseMaster(m.userId, next); toast(next ? '새 진입을 멈췄어요' : '멈춤을 풀었어요'); await reload(); } catch (e) { toast(copyErrMsg(e, '바꾸지 못했어요'), 'err'); }
  };
  const kick = async (m: AdminCopyMaster) => {
    try { await api.adminCopyMasterKick(m.userId); toast(`${m.nickname} 감시를 깨웠어요`); }
    catch (e) { toast(copyErrMsg(e, '실패'), 'err'); }
  };
  const stopFollow = async (id: number, who: string) => {
    if (!window.confirm(`${who} 님의 따라하기를 정지할까요? 포지션은 남아요.`)) return;
    try { await api.adminCopyFollowStop(id); toast('정지했어요'); await reload(); }
    catch (e) { toast(copyErrMsg(e, '실패'), 'err'); }
  };
  return { decide, resetStats, pauseGlobal, pauseMaster, kick, stopFollow };
}
export type CopyAdminActions = ReturnType<typeof useCopyAdminActions>;

const modeWord = (mode: AdminCopyMaster['mode']) => (mode === 'live' ? '실거래' : '연습 엔진');
/** 멈출 때 정리하지 못해 사용자 확인을 기다리는 포지션 수 — 글자 + 주의 배지 */
const LeftoverBadge = ({ n }: { n?: number }) => (n ? <span className="badge warn" style={{ whiteSpace: 'normal' }}>⚠️ 정리 못 한 포지션 {n}건</span> : null);

/** 승인된 고수 한 줄: 감시 즉시 확인 / 새 진입 멈춤은 바로, 중지·통계 초기화는 "⋯ 더 보기" 뒤에 */
function MasterRow({ m, a }: { m: AdminCopyMaster; a: CopyAdminActions }) {
  const [more, setMore] = useState(false);
  return (
    <AdminRow
      title={<>{m.nickname}{m.paused && <span className="badge warn">⏸ 새 진입 멈춤</span>}</>}
      meta={`${m.loginId} · ${modeWord(m.mode)} · API 키 ${m.hasApiKey ? '있음' : '없음'} · 팔로워 ${m.followers}명`}
      actions={<>
        <button className="btn small ghost" onClick={() => a.kick(m)}>감시 즉시 확인</button>
        <button className={`btn small ${m.paused ? 'primary' : 'ghost'}`} onClick={() => a.pauseMaster(m, !m.paused)}>{m.paused ? '▶ 새 진입 멈춤 풀기' : '⏸ 새 진입만 멈추기'}</button>
        <button className="btn small ghost" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? '▴ 접기' : '⋯ 더 보기'}</button>
      </>}
      extra={more && (
        <div className="admin-more">
          <button className="btn small danger" onClick={() => a.decide(m, 'suspend')}>중지 (팔로워 전원 멈춤)</button>
          <div className="hint" style={{ marginTop: '0.5rem', marginBottom: '0.2rem' }}>통계 초기화 (지금 이후 거래부터 새로 집계)</div>
          <div className="grid2">
            {(Object.keys(RESET_LABEL) as (keyof typeof RESET_LABEL)[]).map((k) => <button key={k} className="btn small ghost" onClick={() => a.resetStats(m, k)}>{RESET_LABEL[k]} 초기화</button>)}
          </div>
        </div>
      )}
    >
      {(!m.hasApiKey || m.mode !== 'live') && <div className="small" style={{ color: 'var(--danger)' }}>⚠️ 감시 조건 미달 (실거래 + API 키 필요)</div>}
      {m.paused && <div className="small muted">⏸ 이 고수의 새 진입은 멈춰 있어요 (정리·손절 변경은 계속)</div>}
    </AdminRow>
  );
}

/** 관리자 · 고수 따라하기 탭: 상태 배너(전체 멈춤) · 승인 고수 · 중지/거절(접이식) · 따라가는 중 · 최근 이벤트 */
export function CopyAdminCard({ copy, onGoApprove }: { copy: Loaded<AdminCopyResponse>; onGoApprove: () => void }) {
  const a = useCopyAdminActions(copy.reload);
  const d = copy.data;
  const [allEvents, setAllEvents] = useState(false);
  const active = d?.follows.filter((f) => f.status === 'active') ?? [];
  const stopped = d?.follows.filter((f) => f.status !== 'active') ?? [];
  const events = d ? (allEvents ? d.events : d.events.slice(0, EVENTS_SHOWN)) : [];
  return (
    <div className="card">
      <SectionHead title="고수 따라하기 (카피 트레이딩)" />
      {d && d.pending.length > 0 && <TabLink text={`고수 신청 ${d.pending.length}건은 승인 탭에서`} onClick={onGoApprove} />}
      <LoadSlot data={d} error={copy.error} onRetry={copy.reload}>{() => d && (
        <>
          <div className={`banner ${d.pausedGlobal ? 'warn' : ''}`} style={{ marginBottom: '0.4rem' }}>
            <div style={{ fontWeight: 900 }}>{d.pausedGlobal ? '⛔ 전체 새 진입 멈춤 중' : '🟢 복제 정상 동작 중'}</div>
            <div className="small muted">긴급 정지: 모든 고수의 새 진입만 멈춰요. 정리·손절 변경·손실 한도는 계속 동작해요.</div>
            <button className={`btn small ${d.pausedGlobal ? 'primary' : 'danger'}`} style={{ marginTop: '0.3rem' }} onClick={() => a.pauseGlobal(!d.pausedGlobal)}>{d.pausedGlobal ? '전체 멈춤 풀기' : '⛔ 전체 새 진입 멈추기'}</button>
          </div>

          <SectionHead title="승인된 고수" count={d.approved.length} unit="명" />
          {d.approved.length === 0 && <EmptyLine text="승인된 고수가 없어요." />}
          {d.approved.map((m) => <MasterRow key={m.userId} m={m} a={a} />)}
          {d.suspended.length + d.rejected.length > 0 && (
            <Disclosure title="중지·거절된 고수" count={d.suspended.length + d.rejected.length}>
              {d.suspended.map((m) => (
                <AdminRow key={m.userId} title={`${m.nickname} (중지)`} meta={`${m.loginId}${m.note ? ` — ${m.note}` : ''}`} actions={<button className="btn small ghost" onClick={() => a.decide(m, 'approve')}>다시 승인</button>} />
              ))}
              {d.rejected.map((m) => (
                <AdminRow key={m.userId} title={`${m.nickname} (거절)`} meta={`${m.loginId}${m.note ? ` — ${m.note}` : ''} · 다시 신청하면 승인 탭에 올라와요`} />
              ))}
            </Disclosure>
          )}

          <SectionHead title="따라가는 중" count={active.length} unit="명" />
          {active.length === 0 && <EmptyLine text="아직 따라가는 사람이 없어요." />}
          {active.map((f) => (
            <AdminRow
              key={f.id}
              title={<>{f.followerLoginId} <span className="muted">→</span> {f.masterNickname} <LeftoverBadge n={f.leftovers} /></>}
              meta={<>{modeWord(f.mode)} · {fmtUsdt(f.copyAmount)} USDT (지금 {fmtUsdt(f.copyAmountNow)}) · 정리한 손익 <PnlWord v={f.realizedPnl} word={false} /> · {fmtWhen(f.startedAt)}부터</>}
              actions={<button className="btn small danger" onClick={() => a.stopFollow(f.id, f.followerLoginId)}>정지</button>}
            />
          ))}
          {stopped.length > 0 && (
            <Disclosure title="멈춘 사람" count={stopped.length}>
              {stopped.map((f) => (
                <AdminRow key={f.id} title={<>{f.followerLoginId} <span className="muted">→</span> {f.masterNickname} <LeftoverBadge n={f.leftovers} /></>} meta={`멈춤 ${f.stoppedAt ? fmtWhen(f.stoppedAt) : ''} · ${f.stopReason ? STOP_REASON[f.stopReason] : ''} · 정리한 손익 ${f.realizedPnl > 0 ? '+' : ''}${fmtUsdt(f.realizedPnl)} USDT`} />
              ))}
            </Disclosure>
          )}

          <SectionHead title="최근 이벤트" count={d.events.length} />
          {d.events.length === 0 && <EmptyLine text="아직 이벤트가 없어요." />}
          {events.map((ev) => (
            <div key={ev.id} className="small" style={{ padding: '0.25rem 0', borderTop: '1px dashed var(--line)', overflowWrap: 'anywhere' }}>
              {fmtWhen(ev.createdAt)} · 고수 #{ev.masterId} · {SYMBOL_LABEL[ev.symbol].name} {kindLabel(ev.kind, ev.direction)}{ev.kind === 'close' && closeReasonLabel(ev.closeReason) ? ` [${closeReasonLabel(ev.closeReason)}]` : ''} {ev.leverage ? `${ev.leverage}배` : ''} · {fmtPrice(ev.price)} 달러 · {ev.beforeContracts}→{ev.afterContracts}계약 · {ev.followerCount == null ? '처리 중' : `성공 ${ev.okCount ?? 0} / 팔로워 ${ev.followerCount}${ev.failCount ? ` · 실패 ${ev.failCount}` : ''}${ev.skippedCount ? ` · 건너뜀 ${ev.skippedCount}` : ''}`}
            </div>
          ))}
          <MoreToggle expanded={allEvents} hidden={d.events.length - EVENTS_SHOWN} onToggle={() => setAllEvents((v) => !v)} />
        </>
      )}</LoadSlot>
    </div>
  );
}
