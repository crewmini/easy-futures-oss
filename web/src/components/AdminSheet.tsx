import { useEffect, useRef, useState } from 'react';
import type { AdminAutoBalance, AdminAutoBalancesResponse, AdminPartner, Symbol } from '@easy-futures/shared';
import { SYMBOLS, SYMBOL_LABEL } from '@easy-futures/shared';
import { api, ApiError, type AdminAutoUser } from '../lib/api';
import { useToast } from './Toast';
import { BotCard, botTelegramOk, botTelegramText } from './BotCard';
import { CopyAdminCard, useCopyAdminActions } from './CopyAdminCard';
import { copyErrMsg, fmtWhen } from './CopyCommon';
import { AdminRow, Disclosure, EmptyLine, LoadSlot, MoreToggle, SectionHead, TabLink, useAdminLoad, type Loaded } from './AdminCommon';

/**
 * 관리자 화면. 위에서부터: 뒤로/제목 → "오늘 할 일"(대기 승인 건수 + 시스템 상태 한 줄) → 고정 탭 5개 → 켜진 탭 내용만.
 * 데이터 5종(신분증·AI 자동매매·카피·제휴사·저점 봇)은 열 때 한 번 다 불러와 할 일 건수를 맞추고, 동작 뒤에는 해당 데이터만 다시 읽는다.
 * 폴링은 AI 탭이 보일 때의 승인 사용자 잔고(60초)뿐.
 */

type AdminTab = 'approve' | 'auto' | 'copy' | 'bot' | 'members';
type ApproveGroup = 'kyc' | 'auto' | 'copy' | 'partner';
const TABS: { id: AdminTab; label: string }[] = [
  { id: 'approve', label: '승인' },
  { id: 'auto', label: 'AI 매매' },
  { id: 'copy', label: '고수' },
  { id: 'bot', label: '저점 봇' },
  { id: 'members', label: '회원 제휴' },
];
const TAB_KEY = 'ef.adminTab';
const readTab = (): AdminTab | null => { try { const v = localStorage.getItem(TAB_KEY); return TABS.some((t) => t.id === v) ? (v as AdminTab) : null; } catch { return null; } };
const saveTab = (t: AdminTab) => { try { localStorage.setItem(TAB_KEY, t); } catch { /* 저장 못 해도 동작에는 지장 없음 */ } };

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '불러오지 못했어요');
const copyMsg = (e: unknown) => copyErrMsg(e, '불러오지 못했어요');
type AutoResp = Awaited<ReturnType<typeof api.adminAuto>>;
type DecideAuto = (u: AdminAutoUser, action: 'approve' | 'suspend' | 'reject') => Promise<void>;

const DOC_LABEL: Record<string, string> = { id_card: '주민등록증', driver_license: '운전면허증', passport: '여권' };
const SIGNALS_SHOWN = 5;
const usdt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString('ko-KR') : '—');

/** 승인 사용자 줄 아래 잔고 한 줄: 불러오는 중 / 실패 / 잔고 + 포지션 요약 */
function BalanceLine({ b }: { b: AdminAutoBalance | null | undefined }) {
  if (b === undefined) return <div className="small muted">잔고 불러오는 중…</div>;
  if (b === null) return null;
  if (!b.wallet) return <div className="small muted">잔고 확인 실패: {b.error ?? '알 수 없음'}</div>;
  const pos = b.positions.map((p) => `${SYMBOL_LABEL[p.symbol].name} ${p.direction === 'long' ? '오른다' : '내린다'} ${p.contracts}계약`).join(', ');
  return <div className="small muted" style={{ overflowWrap: 'anywhere' }}>잔고 {usdt(b.wallet.equity)} USDT (사용 가능 {usdt(b.wallet.available)}) · {b.mode === 'live' ? '실거래' : '연습 엔진(관리자 전용)'}{pos ? ` · 포지션 ${pos}` : ''}</div>;
}

export function AdminSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const kyc = useAdminLoad(api.adminKycList, errMsg);
  const auto = useAdminLoad(api.adminAuto, errMsg);
  const copy = useAdminLoad(api.adminCopy, copyMsg);
  const partners = useAdminLoad(api.adminPartners, errMsg);
  const bot = useAdminLoad(api.adminBot, errMsg);
  const copyActions = useCopyAdminActions(copy.reload);

  const nKyc = kyc.data?.items.length ?? 0;
  const nAuto = auto.data?.pending.length ?? 0;
  const nCopy = copy.data?.pending.length ?? 0;
  const nPartner = partners.data?.applications.length ?? 0;
  const nAll = nKyc + nAuto + nCopy + nPartner;
  const ready = kyc.loaded && auto.loaded && copy.loaded && partners.loaded;

  // 탭: 처음엔 기억한 탭(없으면 AI 자동매매). 네 데이터가 다 오면 대기 건이 있을 때 한 번만 승인 탭으로. 사람이 고른 탭만 기억한다.
  const [tab, setTab] = useState<AdminTab>(() => readTab() ?? 'auto');
  const chosen = useRef(false);
  const decided = useRef(false);
  const chooseTab = (t: AdminTab) => { chosen.current = true; setTab(t); saveTab(t); };
  useEffect(() => {
    if (!ready || decided.current) return;
    decided.current = true;
    if (nAll > 0 && !chosen.current) setTab('approve');
  }, [ready, nAll]);
  // 탭을 바꾸면 이전 탭에서 내려간 만큼 스크롤이 남지 않게, 고정 탭 줄이 맨 위에 오도록 올린다
  // (고정 탭 줄 자체는 붙어 있을 때 위치가 0 이라 재지 못하므로, 바로 위 "오늘 할 일" 카드의 아래끝을 기준으로 잰다)
  const sheetRef = useRef<HTMLDivElement>(null);
  const todoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sheet = sheetRef.current, todo = todoRef.current;
    if (!sheet || !todo) return;
    const navTop = todo.offsetTop + todo.offsetHeight;
    if (sheet.scrollTop > navTop) sheet.scrollTop = navTop;
  }, [tab]);
  const [scrollTo, setScrollTo] = useState<ApproveGroup | null>(null);
  const goApprove = (g: ApproveGroup) => { chooseTab('approve'); setScrollTo(g); };
  useEffect(() => {
    if (tab !== 'approve' || !scrollTo) return;
    document.getElementById(`grp-${scrollTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollTo(null);
  }, [tab, scrollTo]);

  // ---- 동작: 신분증 · AI 자동매매 승인 · 제휴사 · 비밀번호 ----
  const [busy, setBusy] = useState<number | null>(null);
  const decideKyc = async (userId: number, action: 'approve' | 'reject') => {
    const note = action === 'reject' ? (window.prompt('거절 사유 (사용자에게 보여요)', '신분증이 흐리거나 정보가 가려져 있어요. 다시 찍어 주세요') ?? undefined) : undefined;
    if (action === 'reject' && note === undefined) return;
    setBusy(userId);
    try { await api.adminKycDecide(userId, action, note); toast(action === 'approve' ? '승인했어요' : '거절했어요'); await kyc.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
    finally { setBusy(null); }
  };
  const decideAuto: DecideAuto = async (u, action) => {
    const note = action !== 'approve' ? (window.prompt('사유 (사용자에게 보여요)', action === 'suspend' ? '결제 확인이 필요해요' : '') ?? undefined) : undefined;
    if (action !== 'approve' && note === undefined) return;
    try { await api.adminAutoDecide(u.userId, action, note); toast(action === 'approve' ? 'AI 자동매매를 승인했어요' : action === 'suspend' ? '중지했어요' : '거절했어요'); await auto.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const decidePartner = async (userId: number, action: 'approve' | 'reject') => {
    const note = action === 'reject' ? (window.prompt('거절 사유 (신청자에게 보여요)', '확인이 필요해 이번에는 승인하지 않았어요') ?? undefined) : undefined;
    if (action === 'reject' && note === undefined) return;
    try { const r = await api.adminDecidePartner(userId, action, note); toast(action === 'approve' ? `승인했어요 (코드 ${r.code})` : '거절했어요'); await partners.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const removePartner = async (p: AdminPartner) => {
    if (!window.confirm(`${p.loginId} (${p.name ?? '-'}) 제휴사를 제거할까요? 코드가 없어지고 고객 ${p.members}명의 연결이 풀려요.`)) return;
    try { await api.adminRemovePartner(p.userId); toast('제휴사를 제거했어요'); await partners.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const [newPartner, setNewPartner] = useState('');
  const createPartner = async () => {
    try { const r = await api.adminCreatePartner(newPartner.trim()); toast(`${r.loginId} 님을 제휴사로 지정했어요 (코드 ${r.code})`); setNewPartner(''); await partners.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const [resetId, setResetId] = useState('');
  const [tempPw, setTempPw] = useState<{ loginId: string; tempPassword: string } | null>(null);
  const resetPw = async () => {
    if (!window.confirm(`${resetId.trim()} 님의 비밀번호를 초기화할까요? 기존 로그인이 모두 풀려요.`)) return;
    try { const r = await api.adminResetPassword(resetId.trim()); setTempPw({ loginId: r.loginId, tempPassword: r.tempPassword }); setResetId(''); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };

  // ---- 시스템 상태 한 줄 (아이콘 + 글자) ----
  const healthTg = bot.data ? `${botTelegramOk(bot.data) ? '✅' : '⚠️'} ${botTelegramText(bot.data)}` : bot.error ? '⚠️ 봇 상태 확인 실패' : '텔레그램 확인 중…';
  const healthCopy = copy.data ? (copy.data.pausedGlobal ? '⛔ 복제 전체 멈춤' : '🟢 복제 정상') : copy.error ? '⚠️ 복제 상태 확인 실패' : '복제 확인 중…';
  const healthAi = auto.data ? `🤖 AI 켜진 사용자 ${auto.data.approved.filter((u) => u.enabled).length}명` : auto.error ? '⚠️ AI 상태 확인 실패' : 'AI 확인 중…';

  return (
    <div className="sheet" ref={sheetRef}><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>관리자</h2></div>

      <div className="card admin-todo" ref={todoRef}>
        <SectionHead title="오늘 할 일" />
        {!ready && <div className="admin-empty">불러오는 중…</div>}
        {ready && nAll === 0 && <div className="admin-todo-none">기다리는 승인이 없어요 ✅</div>}
        {ready && nAll > 0 && (
          <div className="admin-chips">
            {nKyc > 0 && <button className="btn small admin-chip" onClick={() => goApprove('kyc')}><span>🪪 신분증</span><b>{nKyc}건 →</b></button>}
            {nAuto > 0 && <button className="btn small admin-chip" onClick={() => goApprove('auto')}><span>🤖 AI 자동매매 신청</span><b>{nAuto}건 →</b></button>}
            {nCopy > 0 && <button className="btn small admin-chip" onClick={() => goApprove('copy')}><span>🏅 고수 신청</span><b>{nCopy}건 →</b></button>}
            {nPartner > 0 && <button className="btn small admin-chip" onClick={() => goApprove('partner')}><span>🤝 제휴사 신청</span><b>{nPartner}건 →</b></button>}
          </div>
        )}
        <div className="small muted admin-health">{healthTg} · {healthCopy} · {healthAi}</div>
      </div>

      <nav className="admin-nav" role="tablist" aria-label="관리자 메뉴">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`btn small ${tab === t.id ? 'selected' : 'ghost'}`} onClick={() => chooseTab(t.id)}>
            <span className="admin-nav-label">{t.label}</span>
            {t.id === 'approve' && nAll > 0 && <span className="admin-nav-count">{nAll}</span>}
          </button>
        ))}
      </nav>

      {tab === 'approve' && (
        <>
          <div className="card admin-group" id="grp-kyc">
            <SectionHead title="신분증 승인" count={nKyc} hot />
            <LoadSlot data={kyc.data} error={kyc.error} onRetry={kyc.reload} isEmpty={nKyc === 0} emptyText="기다리는 신분증이 없어요.">{() => kyc.data?.items.map((it) => (
              <div className="kyc-item" key={it.userId}>
                <div className="kv"><span className="k">아이디</span><span className="v">{it.loginId}</span></div>
                <div className="kv"><span className="k">UID</span><span className="v">{it.uid ?? '—'}</span></div>
                <div className="kv"><span className="k">신분증</span><span className="v">{it.docType ? DOC_LABEL[it.docType] : '—'}</span></div>
                <div className="kv"><span className="k">제출</span><span className="v small">{when(it.submittedAt)}</span></div>
                <img src={`/api/admin/kyc/${it.userId}/image`} alt="신분증" style={{ width: '100%', borderRadius: 12, margin: '0.6rem 0', border: '1px solid var(--line)' }} />
                <div className="grid2">
                  <button className="btn primary" disabled={busy === it.userId} onClick={() => decideKyc(it.userId, 'approve')}>승인</button>
                  <button className="btn danger" disabled={busy === it.userId} onClick={() => decideKyc(it.userId, 'reject')}>거절</button>
                </div>
              </div>
            ))}</LoadSlot>
          </div>

          <div className="card admin-group" id="grp-auto">
            <SectionHead title="AI 자동매매 신청" count={nAuto} hot />
            <LoadSlot data={auto.data} error={auto.error} onRetry={auto.reload} isEmpty={nAuto === 0} emptyText="기다리는 신청이 없어요.">{() => auto.data?.pending.map((u) => (
              <AdminRow
                key={u.userId}
                title={u.loginId}
                meta={`UID ${u.uid ?? '—'} · ${u.pct}% · 최대 ${u.maxLeverage}배 · 신청 ${when(u.appliedAt)} · 결제 확인 후 승인하세요`}
                actions={<>
                  <button className="btn small primary" onClick={() => decideAuto(u, 'approve')}>승인 (결제 확인됨)</button>
                  <button className="btn small danger" onClick={() => decideAuto(u, 'reject')}>거절</button>
                </>}
              />
            ))}</LoadSlot>
          </div>

          <div className="card admin-group" id="grp-copy">
            <SectionHead title="고수 신청" count={nCopy} hot />
            <LoadSlot data={copy.data} error={copy.error} onRetry={copy.reload} isEmpty={nCopy === 0} emptyText="기다리는 신청이 없어요.">{() => copy.data?.pending.map((m) => (
              <AdminRow
                key={m.userId}
                title={m.nickname}
                meta={`${m.loginId} · ${m.mode === 'live' ? '실거래' : '연습 엔진'} · API 키 ${m.hasApiKey ? '있음' : '없음'} · 신청 ${m.appliedAt ? fmtWhen(m.appliedAt) : '—'}`}
                actions={<>
                  <button className="btn small primary" onClick={() => copyActions.decide(m, 'approve')}>승인</button>
                  <button className="btn small danger" onClick={() => copyActions.decide(m, 'reject')}>거절</button>
                </>}
              >
                {m.intro && <div className="small" style={{ overflowWrap: 'anywhere' }}>{m.intro}</div>}
              </AdminRow>
            ))}</LoadSlot>
          </div>

          <div className="card admin-group" id="grp-partner">
            <SectionHead title="제휴사 신청" count={nPartner} hot />
            <LoadSlot data={partners.data} error={partners.error} onRetry={partners.reload} isEmpty={nPartner === 0} emptyText="기다리는 신청이 없어요.">{() => partners.data?.applications.map((a) => (
              <AdminRow
                key={a.userId}
                title={<>{a.name} <span className="muted small">· {a.company}</span></>}
                meta={`${a.loginId} · UID ${a.uid ?? '—'} · ${a.phone} · ${when(a.submittedAt)}`}
                actions={<>
                  <button className="btn small primary" onClick={() => decidePartner(a.userId, 'approve')}>승인</button>
                  <button className="btn small danger" onClick={() => decidePartner(a.userId, 'reject')}>거절</button>
                </>}
              />
            ))}</LoadSlot>
          </div>
        </>
      )}

      {tab === 'auto' && <AutoPanel auto={auto} decideAuto={decideAuto} onGoApprove={() => goApprove('auto')} />}
      {tab === 'copy' && <CopyAdminCard copy={copy} onGoApprove={() => goApprove('copy')} />}
      {tab === 'bot' && <BotCard bot={bot} />}

      {tab === 'members' && (
        <>
          <div className="card">
            <SectionHead title="비밀번호 초기화" />
            <div className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>비밀번호를 잊은 회원의 아이디를 넣으면 임시 비밀번호가 나와요. 전화로 알려 주세요. 회원은 로그인 직후 새 비밀번호를 정해야 해요.</div>
            <div className="row">
              <input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} autoCapitalize="none" placeholder="회원 아이디" aria-label="회원 아이디" value={resetId} onChange={(e) => setResetId(e.target.value)} />
              <button className="btn danger" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={!resetId.trim()} onClick={resetPw}>초기화</button>
            </div>
            {tempPw && <div className="banner warn" style={{ marginTop: '0.6rem' }}>{tempPw.loginId} 님 임시 비밀번호: <b style={{ fontSize: '1.4rem', letterSpacing: '0.1em' }}>{tempPw.tempPassword}</b><br /><span className="small">이 화면을 닫으면 다시 볼 수 없어요.</span></div>}
          </div>
          <div className="card">
            <SectionHead title="제휴사 목록 · 직접 지정" count={partners.data?.partners.length} unit="곳" />
            {nPartner > 0 && <TabLink text={`제휴사 신청 ${nPartner}건은 승인 탭에서`} onClick={() => goApprove('partner')} />}
            <div className="row" style={{ marginTop: '0.3rem' }}>
              <input className="num" style={{ textAlign: 'left', fontSize: '1rem' }} autoCapitalize="none" placeholder="회원 아이디" aria-label="제휴사로 지정할 회원 아이디" value={newPartner} onChange={(e) => setNewPartner(e.target.value)} />
              <button className="btn primary" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={!newPartner.trim()} onClick={createPartner}>지정</button>
            </div>
            <LoadSlot data={partners.data} error={partners.error} onRetry={partners.reload} isEmpty={(partners.data?.partners.length ?? 0) === 0} emptyText="아직 제휴사가 없어요.">{() => partners.data?.partners.map((p) => (
              <AdminRow
                key={p.userId}
                title={<>{p.name ?? p.loginId} <span className="muted small">· {p.company ?? '직접 지정'}</span></>}
                meta={`${p.loginId} · ${p.code} · 고객 ${p.members}명${p.phone ? ` · ${p.phone}` : ''}`}
                actions={<button className="btn small danger" onClick={() => removePartner(p)}>제거</button>}
              />
            ))}</LoadSlot>
          </div>
        </>
      )}
    </div></div>
  );
}

/** AI 자동매매 탭: 요약 줄 · 승인 사용자(잔고 60초, 이 탭이 보일 때만) · 중지/거절(접이식) · 🧪 수동 신호(접이식) · 최근 신호 5건 + 더 보기 */
function AutoPanel({ auto, decideAuto, onGoApprove }: { auto: Loaded<AutoResp>; decideAuto: DecideAuto; onGoApprove: () => void }) {
  const toast = useToast();
  const d = auto.data;
  const hasApproved = (d?.approved.length ?? 0) > 0;
  const [balances, setBalances] = useState<AdminAutoBalancesResponse | null>(null);
  useEffect(() => {
    if (!hasApproved) return;
    let alive = true;
    const tick = () => api.adminAutoBalances().then((r) => { if (alive) setBalances(r); }).catch(() => {});
    void tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [hasApproved]);
  const balanceOf = (userId: number): AdminAutoBalance | null | undefined => (balances ? (balances.balances.find((b) => b.userId === userId) ?? null) : undefined);

  const [execView, setExecView] = useState<{ id: string; rows: { loginId: string; mode: string; status: string; detail: string | null }[] } | null>(null);
  const openExec = async (id: string) => {
    if (execView?.id === id) { setExecView(null); return; }
    try { const r = await api.adminSignalExecutions(id); setExecView({ id, rows: r.executions }); } catch (e) { toast(e instanceof ApiError ? e.message : '불러오지 못했어요', 'err'); }
  };
  const rerun = async (id: string) => {
    if (!window.confirm('아직 실행 기록이 없는 사용자에게만 다시 실행해요. 진행할까요?')) return;
    try { const r = await api.adminSignalRerun(id); toast(`다시 실행: 성공 ${r.result.ok} · 실패 ${r.result.fail} · 건너뜀 ${r.result.skipped}`); await auto.reload(); setExecView(null); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const [sig, setSig] = useState<{ symbol: Symbol; action: 'open' | 'close'; direction: 'long' | 'short'; leverage: number; note: string }>({ symbol: 'BTCUSDT', action: 'open', direction: 'long', leverage: 3, note: '테스트' });
  const sendSignal = async () => {
    if (!window.confirm(`${sig.symbol} ${sig.action} ${sig.action === 'open' ? sig.direction + ' ' + sig.leverage + '배' : ''} 신호를 AI 자동매매 사용자 전원에게 보낼까요? (실거래 사용자는 진짜 돈)`)) return;
    try { const r = await api.adminAutoSignal({ symbol: sig.symbol, action: sig.action, direction: sig.action === 'open' ? sig.direction : undefined, leverage: sig.action === 'open' ? sig.leverage : undefined, note: sig.note }); toast(`보냈어요: ${r.result.ok}명 실행, ${r.result.fail}명 실패, ${r.result.skipped}명 건너뜀`); await auto.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); }
  };
  const [allSignals, setAllSignals] = useState(false);
  const signals = d ? (allSignals ? d.signals : d.signals.slice(0, SIGNALS_SHOWN)) : [];
  const nInactive = (d?.suspended.length ?? 0) + (d?.rejected?.length ?? 0);

  return (
    <div className="card">
      <SectionHead title="AI 자동매매" />
      {d && d.pending.length > 0 && <TabLink text={`신청 ${d.pending.length}건은 승인 탭에서`} onClick={onGoApprove} />}
      {d && !d.signalSecretSet && <div className="banner warn">봇 신호 비밀키(AUTO_SIGNAL_SECRET)가 아직 서버에 없어요. 수동 신호만 가능해요.</div>}
      <LoadSlot data={d} error={auto.error} onRetry={auto.reload}>{() => d && (
        <>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>승인 {d.approved.length}명 · 켜짐 {d.approved.filter((u) => u.enabled).length}명{balances ? ` · 잔고 갱신 ${new Date(balances.cachedAt).toLocaleTimeString('ko-KR', { hour12: false })}` : ''}</div>
          <SectionHead title="승인된 사용자" count={d.approved.length} unit="명" />
          {d.approved.length === 0 && <EmptyLine text="승인된 사용자가 없어요." />}
          {d.approved.map((u) => (
            <AdminRow
              key={u.userId}
              title={<>{u.loginId}<span className={`badge ${u.enabled ? 'ok' : 'neutral'}`}>{u.enabled ? '🟢 켜짐' : '⚪ 꺼짐'}</span></>}
              meta={`UID ${u.uid ?? '—'} · ${u.pct}% · 최대 ${u.maxLeverage}배`}
              actions={<button className="btn small ghost" onClick={() => decideAuto(u, 'suspend')}>중지</button>}
            >
              <BalanceLine b={balanceOf(u.userId)} />
            </AdminRow>
          ))}
          {nInactive > 0 && (
            <Disclosure title="중지·거절된 사용자" count={nInactive}>
              {d.suspended.map((u) => (
                <AdminRow key={u.userId} title={`${u.loginId} (중지)`} meta={u.note ?? ''} actions={<button className="btn small ghost" onClick={() => decideAuto(u, 'approve')}>다시 승인</button>} />
              ))}
              {d.rejected?.map((u) => (
                <AdminRow key={u.userId} title={`${u.loginId} (거절)`} meta={`${u.note ? `${u.note} · ` : ''}다시 신청하면 승인 탭에 올라와요`} />
              ))}
            </Disclosure>
          )}

          <Disclosure title="🧪 수동 신호 (테스트·긴급)">
            <div className="hint" style={{ marginTop: 0, marginBottom: '0.4rem' }}>AI 자동매매가 켜진 사용자 전원에게 바로 나가요. 실거래 사용자는 진짜 돈이에요.</div>
            <div className="grid3" style={{ marginBottom: '0.4rem' }}>
              {SYMBOLS.map((s) => <button key={s} className={`btn small ${sig.symbol === s ? 'selected' : ''}`} aria-pressed={sig.symbol === s} onClick={() => setSig({ ...sig, symbol: s })}>{SYMBOL_LABEL[s].name}</button>)}
            </div>
            <div className="grid3" style={{ marginBottom: '0.4rem' }}>
              <button className={`btn small ${sig.action === 'open' && sig.direction === 'long' ? 'selected' : ''}`} aria-pressed={sig.action === 'open' && sig.direction === 'long'} onClick={() => setSig({ ...sig, action: 'open', direction: 'long' })}>오른다 진입</button>
              <button className={`btn small ${sig.action === 'open' && sig.direction === 'short' ? 'selected' : ''}`} aria-pressed={sig.action === 'open' && sig.direction === 'short'} onClick={() => setSig({ ...sig, action: 'open', direction: 'short' })}>내린다 진입</button>
              <button className={`btn small ${sig.action === 'close' ? 'selected' : ''}`} aria-pressed={sig.action === 'close'} onClick={() => setSig({ ...sig, action: 'close' })}>정리</button>
            </div>
            {sig.action === 'open' && <div className="grid4" style={{ marginBottom: '0.4rem' }}>{[2, 3, 5, 10].map((l) => <button key={l} className={`btn small ${sig.leverage === l ? 'selected' : ''}`} aria-pressed={sig.leverage === l} onClick={() => setSig({ ...sig, leverage: l })}>{l}배</button>)}</div>}
            <button className="btn danger" onClick={sendSignal}>신호 보내기</button>
          </Disclosure>

          <SectionHead title="최근 신호" count={d.signals.length} />
          {d.signals.length === 0 && <EmptyLine text="아직 신호가 없어요." />}
          {signals.map((s) => (
            <div key={s.id} style={{ padding: '0.2rem 0', borderTop: '1px dashed var(--line)' }}>
              <button className="btn small ghost" style={{ textAlign: 'left', justifyContent: 'flex-start', whiteSpace: 'normal', overflowWrap: 'anywhere' }} aria-expanded={execView?.id === s.id} onClick={() => openExec(s.id)}>
                {new Date(s.createdAt).toLocaleTimeString('ko-KR')} · {s.source} · {s.symbol} {s.action} {s.direction ?? ''} {s.leverage ? s.leverage + '배' : ''} · {s.followerCount != null ? `${s.okCount}/${s.followerCount}${s.failCount ? ` · 실패 ${s.failCount}` : ''}` : '처리 중'}{s.note ? ` · ${s.note}` : ''} {execView?.id === s.id ? '▲' : '▼'}
              </button>
              {execView?.id === s.id && (
                <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '0.4rem 0.6rem', margin: '0.2rem 0 0.4rem' }}>
                  {execView.rows.length === 0 && <div className="small muted">실행 기록 없음</div>}
                  {execView.rows.map((r, i) => <div key={i} className="small" style={{ overflowWrap: 'anywhere' }}><b>{r.loginId}</b> · {r.mode === 'live' ? '실거래' : '연습 엔진'} · <span className={`badge ${r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'fail' : 'warn'}`}>{r.status === 'ok' ? '완료' : r.status === 'failed' ? '실패' : '건너뜀'}</span> {r.detail ?? ''}</div>)}
                  {s.followerCount == null && <button className="btn small" style={{ marginTop: '0.4rem' }} onClick={() => rerun(s.id)}>다시 실행 (기록 없는 사용자만)</button>}
                </div>
              )}
            </div>
          ))}
          <MoreToggle expanded={allSignals} hidden={d.signals.length - SIGNALS_SHOWN} onToggle={() => setAllSignals((v) => !v)} />
        </>
      )}</LoadSlot>
    </div>
  );
}
