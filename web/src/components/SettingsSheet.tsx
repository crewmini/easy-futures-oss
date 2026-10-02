import { useState, type ReactNode } from 'react';
import type { AppState, Me, Settings } from '@easy-futures/shared';
import { SCALE_LABEL, type Scale } from '../hooks/useScale';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';
import { HoldButton } from './HoldButton';
import { InstallBanner } from './InstallBanner';
import { Collapsible } from './Collapsible';

/**
 * 설정 시트. 카드 6장: 내 계정(신분증·거래소·비밀번호·약관·로그아웃·탈퇴) → 화면(글자 크기·홈 화면 추가) → 거래(거래 내역·안전 한도)
 * → 연결 상태(접힘) → 관리(제휴사·관리자) → 관리자 연습 엔진(접힘). 항목은 "이름 | 상태 · 열기 →" 한 줄 버튼(≥56px).
 */
export function SettingsSheet({ state, me, scale, setScale, onClose, onChanged, onOpenKeys, onOpenHistory, onOpenAdmin, onOpenPartner, onOpenPartnerApply, onOpenKyc, onOpenPassword, onOpenDelete, onOpenTerms, onLogout }: {
  state: AppState; me: Me | null; scale: Scale; setScale: (s: Scale) => void; onClose: () => void; onChanged: () => void; onOpenKeys: () => void; onOpenHistory: () => void; onOpenAdmin: () => void; onOpenPartner: () => void; onOpenPartnerApply: () => void; onOpenKyc: () => void; onOpenPassword: () => void; onOpenDelete: () => void; onOpenTerms: () => void; onLogout: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false); // 실거래 전환은 한 번 더 확인 (길게 누르기)
  const s = state.settings;
  const save = async (patch: Partial<Settings>, msg: string) => {
    setBusy(true);
    try {
      const r = await api.saveSettings(patch);
      toast(msg);
      if (r.autoDisabled) toast('AI 자동매매도 함께 꺼졌어요. 거래소에 걸어둔 것이 남아 있으면 직접 확인하세요', 'err');
      onChanged();
    }
    catch (e) { toast(e instanceof ApiError ? e.message : '저장하지 못했어요', 'err'); }
    finally { setBusy(false); }
  };
  const toLive = async () => { await save({ mode: 'live' }, '⚠️ 실거래 모드입니다'); setConfirmLive(false); };
  const kycWord = me?.kycStatus === 'approved' ? '완료 ✅' : me?.kycStatus === 'pending' ? '확인 중 ⏳' : me?.kycStatus === 'rejected' ? '다시 제출 필요 ✗' : '아직 안 했어요 ✗';
  const kycAction = me?.kycStatus === 'pending' ? '다시 보기' : me?.kycStatus === 'rejected' ? '다시 제출' : '확인하기';
  const keyWord = me?.hasApiKey ? `연결됨 ✅ (${me.apiKeyPreview})` : '연결 안 됨 ✗';
  const ready = !!me?.hasApiKey && me?.kycStatus === 'approved';
  const connWord = state.connected ? '정상 ✅' : '확인 필요 ⚠️';
  return (
    <div className="sheet"><div className="inner">
      <div className="sheet-head"><button className="btn ghost" onClick={onClose}>← 뒤로</button><h2>설정</h2></div>

      {/* 내 계정: 실거래 준비 상태(신분증·거래소)와 계정 관리를 한 카드에 */}
      <div className="card">
        <h2>내 계정{me?.loginId ? ` · ${me.loginId}` : ''}</h2>
        <Row label="🪪 본인 확인 (신분증)" value={kycWord} action={me && me.kycStatus !== 'approved' ? kycAction : undefined} onOpen={me && me.kycStatus !== 'approved' ? onOpenKyc : undefined} />
        <Row label="🔑 거래소 연결" value={keyWord} action={me?.hasApiKey ? '바꾸기/해제' : '연결하기'} onOpen={onOpenKeys} />
        {!ready && <div className="hint" style={{ marginTop: '0.3rem' }}>{!me?.hasApiKey ? '내 거래소 계좌로 주문을 보내려면 API 키가 필요해요. 만드는 방법은 다음 화면에 있어요. ' : ''}신분증 확인과 거래소 연결이 모두 끝나야 주문할 수 있어요.</div>}
        {/* 예전 계정이 아직 연습 엔진에 남아 있으면(관리자 아님) 실거래로 넘어가는 버튼만 */}
        {!me?.isAdmin && s.mode === 'paper' && (
          <div className="card" style={{ borderColor: 'var(--danger)', marginTop: '0.6rem', marginBottom: '0.3rem' }}>
            <div className="banner warn" style={{ lineHeight: 1.5 }}>이 계정은 아직 실거래로 바뀌지 않았어요. {ready ? '아래 버튼을 길게 눌러 실거래로 바꿔 주세요.' : '신분증 확인과 거래소 연결을 마치면 바꿀 수 있어요.'}</div>
            <HoldButton label="길게 눌러서 실거래로 바꾸기" className="btn danger" busy={busy} busyLabel="바꾸는 중…" disabled={!ready} onConfirm={toLive} />
          </div>
        )}
        <Row label="비밀번호 바꾸기" onOpen={onOpenPassword} />
        <Row label="이용약관 보기" onOpen={onOpenTerms} />
        <Row label="로그아웃" onOpen={onLogout} />
        <Row label="회원 탈퇴" onOpen={onOpenDelete} danger />
      </div>

      {/* 화면: 글자 크기 + 홈 화면 추가(접힘) */}
      <div className="card">
        <h2>화면</h2>
        <div className="hint" style={{ marginTop: 0, marginBottom: '0.3rem' }}>글자 크기</div>
        <div className="grid3">
          {(Object.keys(SCALE_LABEL) as Scale[]).map((k) => (
            <button key={k} className={`btn ${scale === k ? 'selected' : ''}`} onClick={() => setScale(k)}>{SCALE_LABEL[k]}</button>
          ))}
        </div>
        <Collapsible title="📱 홈 화면에 앱처럼 추가하기" summary="설치 방법 보기" style={{ marginTop: '0.4rem' }}>
          <InstallBanner forceShow />
        </Collapsible>
      </div>

      {/* 거래: 거래 내역 + 안전 한도 (기존 두 카드를 하나로) */}
      <div className="card">
        <h2>거래 내역 · 안전 한도</h2>
        <Row label="📋 거래 내역" value="언제 무엇을 얼마에 · 손익" action="보기" onOpen={onOpenHistory} />
        <div className="hint" style={{ marginTop: '0.5rem', marginBottom: '0.3rem' }}>최대 배율</div>
        <div className="grid4">
          {[10, 20, 50, 100].map((l) => <button key={l} className={`btn small ${s.maxLeverage === l ? 'selected' : ''}`} disabled={busy} onClick={() => save({ maxLeverage: l }, `최대 ${l}배로 정했어요`)}>{l}배</button>)}
        </div>
        <div className="hint" style={{ marginTop: '0.5rem', marginBottom: '0.3rem' }}>1회 최대 금액 (USDT)</div>
        <div className="grid4">
          {[500, 1000, 5000, 100000].map((a) => <button key={a} className={`btn small ${s.maxAmountUsdt === a ? 'selected' : ''}`} disabled={busy} onClick={() => save({ maxAmountUsdt: a }, a >= 100000 ? '1회 금액 제한을 없앴어요' : `1회 최대 ${a} USDT로 정했어요`)}>{a >= 100000 ? '제한 없음' : a}</button>)}
        </div>
      </div>

      {/* 연결 상태: 평소엔 한 줄 요약만 */}
      <div className="card">
        <Collapsible title="연결 상태" summary={`시세 ${connWord}`}>
          <div className="kv"><span className="k">시세</span><span className="v">{state.connected ? '정상 ✅' : '지연 ⚠️'}</span></div>
          {s.mode === 'paper' && <div className="kv"><span className="k">모드</span><span className="v">연습 엔진 (관리자 테스트)</span></div>}
          <div className="kv"><span className="k">환율(표시용)</span><span className="v">1 USDT ≈ {s.usdtKrw}원</span></div>
          <div className="kv"><span className="k">아이디</span><span className="v" style={{ overflowWrap: 'anywhere' }}>{me?.loginId ?? '—'}</span></div>
          <div className="kv"><span className="k">거래소 UID</span><span className="v" style={{ overflowWrap: 'anywhere' }}>{me?.uid ?? '—'}</span></div>
          <div className="kv"><span className="k">본인 확인</span><span className="v">{kycWord}</span></div>
        </Collapsible>
      </div>

      {/* 관리: 제휴사 · 관리자 */}
      <div className="card">
        <h2>관리</h2>
        {me?.partnerStatus === 'approved' && me.affiliateCode ? (
          <Row label="👥 제휴사 페이지" value={`내 코드 ${me.affiliateCode}`} onOpen={onOpenPartner} />
        ) : me?.partnerStatus === 'pending' ? (
          <Row label="👥 제휴사 (영업 담당자)" value="신청 확인 중 ⏳" />
        ) : (
          <Row label="👥 제휴사 (영업 담당자)" value={me?.partnerStatus === 'rejected' ? '이전 신청 거절됨 · 다시 신청 가능' : me?.partnerStatus === 'removed' ? '자격 해제됨 · 다시 신청 가능' : '고객을 모집·관리하는 담당자용'} action="신청하기" onOpen={onOpenPartnerApply} />
        )}
        {me?.isAdmin && <Row label="🛠 관리자 화면" value="저점 봇 · 승인 · 제휴사 · 비밀번호 초기화" onOpen={onOpenAdmin} />}
      </div>

      {/* 관리자 전용: 연습 엔진 (접힘) */}
      {me?.isAdmin && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <Collapsible title="관리자: 연습 엔진" summary={`지금 ${s.mode === 'paper' ? '연습 엔진 (가짜 돈)' : '실거래 (진짜 돈)'}`}>
            <div className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>관리자 전용 테스트. 연습 엔진은 가짜 돈으로 주문을 흉내 내요. 일반 회원에게는 보이지 않아요.</div>
            <div className="seg">
              <button className={`btn ${s.mode === 'paper' ? 'selected' : ''}`} disabled={busy} onClick={() => { setConfirmLive(false); save({ mode: 'paper' }, '연습 엔진으로 바꿨어요 (관리자)'); }}>연습 엔진 (가짜 돈)</button>
              <button className={`btn ${s.mode === 'live' ? 'selected' : ''}`} disabled={busy || !me?.hasApiKey} onClick={() => { if (s.mode === 'live') return; if (me?.kycStatus !== 'approved') { onOpenKyc(); return; } setConfirmLive(true); }}>실거래 (진짜 돈)</button>
            </div>
            {confirmLive && s.mode !== 'live' && (
              <div className="card" style={{ borderColor: 'var(--danger)', marginTop: '0.6rem', marginBottom: 0 }}>
                <div className="banner err" style={{ lineHeight: 1.5 }}>이제부터 새로 걸기가 <b>진짜 돈</b>으로 주문돼요. 손실도 진짜예요.</div>
                <div className="stack">
                  <HoldButton label="길게 눌러서 실거래로 바꾸기" className="btn danger" busy={busy} busyLabel="바꾸는 중…" onConfirm={toLive} />
                  <button className="btn ghost" disabled={busy} onClick={() => setConfirmLive(false)}>취소</button>
                </div>
              </div>
            )}
            <div className="hint">{!me?.hasApiKey ? '실거래는 먼저 거래소를 연결해야 해요.' : me?.kycStatus !== 'approved' ? '신분증 확인이 끝나면 실거래를 켤 수 있어요.' : '실거래로 바꾸면 진짜 돈으로 주문돼요.'}</div>
            {s.mode === 'paper' && (
              <div style={{ marginTop: '0.6rem' }}>
                <HoldButton label="연습 지갑 처음부터 다시 (길게 누르기)" className="btn" onConfirm={async () => { try { await api.paperReset(); toast('연습 지갑을 초기화했어요'); onChanged(); } catch { toast('초기화 실패', 'err'); } }} />
              </div>
            )}
          </Collapsible>
        </div>
      )}
    </div></div>
  );
}

/**
 * 설정 한 줄: 왼쪽 이름, 오른쪽 상태/값 + "열기 →". onOpen 이 있으면 줄 전체가 버튼(≥56px), 없으면 읽기만.
 * 색만으로 뜻을 전하지 않도록 상태 글자에 ✅/✗/⏳ 를 같이 쓴다.
 */
function Row({ label, value, action = '열기', onOpen, danger = false }: { label: ReactNode; value?: ReactNode; action?: string; onOpen?: () => void; danger?: boolean }) {
  const inner = (
    <>
      <span style={{ flex: '1 1 auto', minWidth: 0, fontWeight: 800, overflowWrap: 'anywhere', color: danger ? 'var(--danger)' : undefined }}>{label}</span>
      <span className="small" style={{ flex: '0 1 auto', minWidth: 0, textAlign: 'right', overflowWrap: 'anywhere', fontWeight: 700 }}>
        {value != null && <span className="muted">{value}</span>}
        {onOpen && <span style={{ whiteSpace: 'nowrap', fontWeight: 900, marginLeft: value != null ? '0.4rem' : 0 }}>{action} →</span>}
      </span>
    </>
  );
  const base = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', minHeight: 56, padding: '0.45rem 0.2rem', borderTop: '1px dashed var(--line)' } as const;
  if (!onOpen) return <div style={base}>{inner}</div>;
  return <button type="button" className="btn ghost" onClick={onOpen} style={{ ...base, textAlign: 'left', border: 'none', borderTop: '1px dashed var(--line)', borderRadius: 0 }}>{inner}</button>;
}
