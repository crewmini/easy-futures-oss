import { useEffect, useState } from 'react';
import type { AppState, CopyFollowSettings, CopyMasterProfile, CopyStateResponse, Me } from '@easy-futures/shared';
import { COPY_LIMITS, COPY_TERMS_VERSION, DEFAULT_COPY_FOLLOW, SYMBOL_LABEL } from '@easy-futures/shared';
import { api } from '../lib/api';
import { fmtPct } from '../lib/format';
import { HoldButton } from './HoldButton';
import { CoinLogo } from './CoinLogo';
import { OFFLINE_TEXT } from './PositionCard';
import { useToast } from './Toast';
import { TermsBox } from './TermsBox';
import { COPY_TERMS, COPY_TERMS_ACK } from '../content/copy-terms';
import { AgreeRow } from './CopyView';
import { FollowSettingsPicker, MIRROR_NOTE, clampSettings, copyErrMsg, dirWord, fmtWhen, pnlCls } from './CopyCommon';

/** 고수 프로필 시트: 소개·성적·최근 거래 → 따라하기 폼(자격 확인 → 설정 → 특약 → 길게 눌러 시작) */
export function CopyMasterSheet({ masterId, me, state, copy, offline, onClose, onOpenKyc, onOpenSettings, onGoAuto, onChanged }: {
  masterId: number; me: Me; state: AppState; copy: CopyStateResponse; offline: boolean; onClose: () => void; onOpenKyc: () => void; onOpenSettings: () => void; onGoAuto: () => void; onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [p, setP] = useState<CopyMasterProfile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<CopyFollowSettings>(() => ({ ...DEFAULT_COPY_FOLLOW, copyAmount: Math.max(COPY_LIMITS.copyAmountMin, Math.min(DEFAULT_COPY_FOLLOW.copyAmount, Math.floor(state.wallet.available))) }));
  const [read, setRead] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.copyMaster(masterId).then((r) => { if (alive) setP(r); }).catch((e) => { if (alive) setLoadErr(copyErrMsg(e, '고수 정보를 불러오지 못했어요')); });
    return () => { alive = false; };
  }, [masterId]);

  const el = copy.me.eligible;
  const kycOk = me.kycStatus === 'approved' || el.kyc;
  const live = state.mode === 'live';
  const apiOk = !live || me.hasApiKey || el.apiKey;
  const autoOn = el.autoOn;
  const already = copy.me.follow?.status === 'active' ? copy.me.follow : null;
  const alreadyOther = already && already.masterId !== masterId ? already : null;
  const alreadyThis = already && already.masterId === masterId;
  const overAvail = draft.copyAmount > state.wallet.available;
  // 내 프로필(고수 본인): CopyMasterMe 에 userId 가 없어 닉네임으로 비교
  const isMe = !!p && copy.me.master != null && copy.me.master.status !== 'none' && copy.me.master.nickname === p.nickname;
  const canFollow = kycOk && apiOk && !autoOn && !already && read && agree && !offline && draft.copyAmount >= COPY_LIMITS.copyAmountMin && !overAvail;

  const follow = async () => {
    setBusy(true); setErr(null);
    try {
      await api.copyFollow({ ...clampSettings(draft), masterId, agree: true, copyTermsVersion: COPY_TERMS_VERSION });
      toast(`${p?.nickname ?? '고수'} 따라하기를 시작했어요 🟢`);
      await onChanged(); onClose();
    } catch (e) { setErr(copyErrMsg(e, '시작하지 못했어요')); }
    finally { setBusy(false); }
  };

  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>고수 자세히 보기</h2></div>
      {loadErr && <div className="card" style={{ borderColor: 'var(--danger)' }}><div style={{ fontWeight: 800 }}>{loadErr}</div><button className="btn" style={{ marginTop: '0.5rem' }} onClick={onClose}>돌아가기</button></div>}
      {!p && !loadErr && <div className="empty">불러오는 중…</div>}
      {p && (<>
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: '1.3rem', overflowWrap: 'anywhere' }}>👤 {p.nickname} {alreadyThis && <span className="badge ok">따라가는 중</span>}</div>
          <div className="small muted">{fmtWhen(p.since)}부터 활동 · {p.followers == null ? '팔로워 비공개' : `팔로워 ${p.followers}명`}</div>
          {p.intro && <div style={{ marginTop: '0.5rem', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{p.intro}</div>}
          {/* 고수가 숨긴 항목(hide)은 서버가 보내지 않는다(본인이 볼 때는 보낸다) → 값이 없으면 "비공개" 타일 */}
          <div className="grid2 stats" style={{ marginTop: '0.6rem' }}>
            {p.days30Roi == null
              ? <Stat label="30일 수익률" value="비공개" sub="고수가 숨겼어요" />
              : <Stat label="30일 수익률" value={fmtPct(p.days30Roi)} cls={pnlCls(p.days30Roi)} sub={p.days30Roi > 0 ? '이익' : p.days30Roi < 0 ? '손실' : '변동 없음'} note="30일 손익 ÷ 지금 잔고" />}
            {p.winRate == null
              ? <Stat label="승률" value="비공개" sub="고수가 숨겼어요" />
              : p.trades === 0
                ? <Stat label="승률" value="아직 집계 전" sub="마감한 거래가 없어요" />
                : <Stat label="승률" value={`${Math.round(p.winRate)}%`} sub={p.trades == null ? '거래 횟수 비공개' : `거래 ${p.trades}번 중`} />}
            <Stat label="지금 들고 있는 것" value={p.positions.length === 0 ? '없음' : `${p.positions.length}개`} />
          </div>
          {p.positions.length > 0 && <div className="hist-title" style={{ marginTop: '0.4rem' }}>{p.positions.map((x) => <span key={x.symbol} className={`badge ${x.direction === 'long' ? 'up' : 'down'}`}>{SYMBOL_LABEL[x.symbol].name} {dirWord(x.direction)}</span>)}</div>}
          <div className="hint">수량·금액은 공개하지 않아요. 과거 성적은 앞으로의 결과를 보장하지 않아요.</div>
        </div>

        <div className="card">
          <h2>최근 마감 거래 (고수가 건 돈 기준 %)</h2>
          {!p.recent && <div className="empty">고수가 최근 거래를 비공개로 설정했어요.</div>}
          {p.recent && p.recent.length === 0 && <div className="empty">아직 마감한 거래가 없어요.</div>}
          {(p.recent ?? []).slice(0, 10).map((r, i) => (
            <div key={i} className="kv" style={{ alignItems: 'center', gap: '0.5rem' }}>
              <CoinLogo symbol={r.symbol} size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="hist-title"><span>{SYMBOL_LABEL[r.symbol].name}</span><span className={`badge ${r.direction === 'long' ? 'up' : 'down'}`}>{dirWord(r.direction)}</span></div>
                <div className="small muted">{fmtWhen(r.closedAt)}</div>
              </div>
              <div className={`v ${pnlCls(r.roiPct)}`} style={{ fontWeight: 900, textAlign: 'right' }}>{fmtPct(r.roiPct)}<div className="small">{r.roiPct > 0 ? '이익' : r.roiPct < 0 ? '손실' : '본전'}</div></div>
            </div>
          ))}
        </div>

        {isMe ? (
          <div className="card">
            <h2>따라하기</h2>
            <div className="banner ok" style={{ marginBottom: 0 }}>내 프로필이에요. 팔로워는 '내 팔로워' 카드에서 봐요.</div>
          </div>
        ) : (
        <div className="card">
          <h2>따라하기</h2>
          <div className="banner err" style={{ lineHeight: 1.5 }}>
            고수가 사고팔면 <b>내 계좌에서 자동으로 똑같이</b> 사고팔아요. 고수가 틀리면 나도 잃어요. 이익도 손실도 본인 책임이에요. 언제든 그만 따라갈 수 있어요.
          </div>
          <div className="stack" style={{ marginBottom: '0.6rem' }}>
            <div className="kv compact"><span className="k">신분증 확인</span><span className="v">{kycOk ? '완료 ✅' : <button className="btn small" style={{ width: 'auto', display: 'inline-flex' }} onClick={onOpenKyc}>🪪 하러 가기 ✗</button>}</span></div>
            <div className="kv compact"><span className="k">거래소 API 키 연결</span><span className="v">{live ? (apiOk ? '연결됨 ✅' : <span>API 키 없음 ✗<br /><button className="btn small" style={{ width: 'auto', display: 'inline-flex', marginTop: '0.3rem' }} onClick={onOpenSettings}>⚙️ 설정 열기</button></span>) : <span>연습 엔진 ✅<br /><span className="small muted">관리자 테스트 · 가짜 돈으로 따라가요</span></span>}</span></div>
            <div className="kv compact"><span className="k">AI 자동매매</span><span className="v">{autoOn ? <span style={{ color: 'var(--danger)' }}>켜져 있음 ✗<br /><span className="small">먼저 끄세요 (한 계좌에 두 신호는 안 돼요)</span><br /><button className="btn small" style={{ width: 'auto', display: 'inline-flex', marginTop: '0.3rem', color: 'var(--text)' }} onClick={onGoAuto}>🤖 AI 자동매매로 가기</button></span> : '꺼짐 ✅'}</span></div>
            {alreadyOther && <div className="banner warn" style={{ marginBottom: 0 }}>이미 <b>{alreadyOther.masterNickname}</b> 고수를 따라가는 중이에요. 한 번에 한 고수만 따라갈 수 있어요. 먼저 그만 따라가기를 눌러 주세요.</div>}
            {alreadyThis && <div className="banner ok" style={{ marginBottom: 0 }}>이 고수를 이미 따라가는 중이에요. 설정은 "따라가는 중" 카드에서 바꿀 수 있어요.</div>}
          </div>
          {!already && (<>
            <FollowSettingsPicker draft={draft} setDraft={setDraft} available={state.wallet.available} />
            <div className="hint">{MIRROR_NOTE}</div>
            <TermsBox title="고수 따라하기 특약" version={COPY_TERMS_VERSION} sections={COPY_TERMS} read={read} onRead={() => setRead(true)} />
            <AgreeRow read={read} agree={agree} setAgree={setAgree} text={COPY_TERMS_ACK} />
            {err && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', fontWeight: 800 }}>{err}</div>}
            {offline && <div className="banner err">{OFFLINE_TEXT}</div>}
            <HoldButton label={`길게 눌러서 ${p.nickname} 따라하기 시작`} className="btn primary" busy={busy} busyLabel="시작하는 중…" disabled={!canFollow} onConfirm={follow} />
            {!canFollow && !busy && <div className="hint" style={{ textAlign: 'center' }}>{!kycOk ? '신분증 확인이 먼저예요.' : !apiOk ? '거래소 API 키를 먼저 연결해요.' : autoOn ? 'AI 자동매매를 먼저 꺼요.' : overAvail ? '따라갈 돈을 쓸 수 있는 돈 이하로 줄여 주세요.' : !read ? '특약을 끝까지 읽어 주세요.' : !agree ? '특약에 동의해 주세요.' : offline ? '연결이 돌아오면 시작할 수 있어요.' : ''}</div>}
          </>)}
        </div>
        )}
      </>)}
    </div></div>
  );
}

function Stat({ label, value, cls = '', sub, note }: { label: string; value: string; cls?: string; sub?: string; note?: string }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '0.5rem 0.6rem', minWidth: 0 }}>
      <div className="small muted">{label}</div>
      <div className={`big ${cls}`} style={{ fontSize: '1.15rem' }}>{value}</div>
      {sub && <div className={`small ${cls}`} style={{ fontWeight: 700 }}>{sub}</div>}
      {note && <div className="small muted" style={{ fontSize: '0.8rem' }}>{note}</div>}
    </div>
  );
}
