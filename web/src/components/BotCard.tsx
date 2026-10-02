import { useState } from 'react';
import { api, ApiError, type AdminBotState } from '../lib/api';
import { useToast } from './Toast';
import { AdminRow, Disclosure, EmptyLine, LoadSlot, SectionHead, type Loaded } from './AdminCommon';

const kst = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export const botTelegramOk = (st: AdminBotState) => st.telegramConfigured && st.adminChatConfigured;
export const botTelegramText = (st: AdminBotState) => (st.telegramConfigured ? (st.adminChatConfigured ? '텔레그램 연결됨' : '텔레그램 chat id 없음') : '텔레그램 토큰 없음');

/** 관리자 · 저점 봇 탭: 상태 줄 · 감시목록 · 지금 평가/웹훅 재등록 · ⚙️ 봇 설정(감시 등록·연결·배율·익절)은 접이식 */
export function BotCard({ bot }: { bot: Loaded<AdminBotState> }) {
  const toast = useToast();
  const st = bot.data;
  const [coin, setCoin] = useState('BTC');
  const [tfs, setTfs] = useState<string[]>(['15m', '1h', '4h']);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await bot.reload(); } catch (e) { toast(e instanceof ApiError ? e.message : '실패', 'err'); } finally { setBusy(false); }
  };
  const s = st?.settings;
  const watchRows = st ? Object.entries(st.watches).flatMap(([c, list]) => list.map((tf) => ({ c, tf }))) : [];
  return (
    <div className="card">
      <SectionHead title="저점 봇" />
      {st && !st.telegramConfigured && <div className="banner warn">TELEGRAM_BOT_TOKEN 시크릿이 없어요. 봇은 조용히 꺼져 있어요.</div>}
      {st && st.telegramConfigured && !st.adminChatConfigured && <div className="banner warn">봇에 /start 를 보내 chat_id 를 받은 뒤 TELEGRAM_ADMIN_CHAT_ID 시크릿으로 넣어 주세요.</div>}
      <LoadSlot data={st} error={bot.error} onRetry={bot.reload}>{() => st && (
        <>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>
            {botTelegramOk(st) ? '✅' : '⚠️'} {botTelegramText(st)} · 마지막 평가 {st.engine?.lastTick ? kst(st.engine.lastTick) : '아직 없음'} · 웹훅 {st.engine?.webhook ? '등록됨' : '미등록'}
          </div>
          <div className="grid2" style={{ marginTop: '0.5rem' }}>
            <button className="btn small" disabled={busy} onClick={() => run(() => api.adminBotPoll(), '지금 평가했어요')}>지금 평가</button>
            <button className="btn small" disabled={busy || !st.telegramConfigured} onClick={() => run(() => api.adminBotWebhook(), '웹훅을 다시 등록했어요')}>웹훅 재등록</button>
          </div>

          <SectionHead title="감시목록" count={watchRows.length} unit="개" />
          {watchRows.length === 0 && <EmptyLine text="없음 — 아래 ⚙️ 봇 설정에서 등록하거나 텔레그램에서 /watch BTC" />}
          {watchRows.map(({ c, tf }) => {
            const chain = st.chains[`${c}:${tf}`] ?? [];
            const w = st.states.find((x) => x.coin === c && x.tf === tf);
            return (
              <AdminRow
                key={`${c}:${tf}`}
                title={`${c} · ${tf}`}
                meta={<>
                  {chain.length ? chain.map((e) => `${e.seq}${e.status === 'confirmed' ? '✅' : '⏳'}`).join(' → ') : '카운트 없음'}
                  {!st.supportedCoins.includes(c) && ' · 알림만'}
                  {w?.lastError && ` · ⚠️ ${w.lastError}`}
                </>}
                actions={<button className="btn small ghost" disabled={busy} onClick={() => run(() => api.adminBotWatch({ coin: c, action: 'remove' }), `${c} 감시 해제`)}>해제</button>}
              />
            );
          })}

          <Disclosure title="⚙️ 봇 설정">
            <div className="hint" style={{ marginTop: 0 }}>감시 등록 — 코인과 시간대를 고르고 등록</div>
            <div className="grid2" style={{ marginTop: '0.3rem' }}>
              <input className="num" style={{ textAlign: 'left', fontSize: '1rem', textTransform: 'uppercase' }} value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} placeholder="BTC" aria-label="코인" />
              <button className="btn small primary" disabled={busy || !coin} onClick={() => run(() => api.adminBotWatch({ coin, tfs, action: 'add' }), `${coin} 감시 시작`)}>감시 등록</button>
            </div>
            <div className="grid4" style={{ marginTop: '0.4rem' }}>
              {['15m', '1h', '4h', '1d'].map((tf) => <button key={tf} className={`btn small ${tfs.includes(tf) ? 'selected' : ''}`} aria-pressed={tfs.includes(tf)} onClick={() => setTfs(tfs.includes(tf) ? tfs.filter((x) => x !== tf) : [...tfs, tf])}>{tf}</button>)}
            </div>
            {s && (
              <div style={{ borderTop: '1px solid var(--line)', marginTop: '0.6rem', paddingTop: '0.6rem' }}>
                <AdminRow
                  title={`AI 자동매매 연결 ${s.relay ? '🟢 켜짐' : '⚪ 꺼짐'}`}
                  meta={`${s.leverage}배 · 익절 ${s.tpR}R · TF ${s.tfs.length ? s.tfs.join(' ') : '전체'}`}
                  actions={<button className="btn small ghost" disabled={busy} onClick={() => run(() => api.adminBotSettings({ relay: !s.relay }), s.relay ? '연결을 껐어요' : '연결을 켰어요')}>{s.relay ? '끄기' : '켜기'}</button>}
                />
                <div className="hint" style={{ marginTop: '0.4rem' }}>배율</div>
                <div className="grid4" style={{ marginTop: '0.2rem' }}>{[2, 3, 5, 10].map((l) => <button key={l} className={`btn small ${s.leverage === l ? 'selected' : ''}`} aria-pressed={s.leverage === l} disabled={busy} onClick={() => run(() => api.adminBotSettings({ leverage: l }), `${l}배로 바꿨어요`)}>{l}배</button>)}</div>
                <div className="hint" style={{ marginTop: '0.4rem' }}>익절 (R = 손절폭 배수)</div>
                <div className="grid4" style={{ marginTop: '0.2rem' }}>{[0, 1, 1.5, 2].map((r) => <button key={r} className={`btn small ${s.tpR === r ? 'selected' : ''}`} aria-pressed={s.tpR === r} disabled={busy} onClick={() => run(() => api.adminBotSettings({ tpR: r }), r ? `익절 ${r}R` : '익절 없음')}>{r ? `익절 ${r}R` : '익절 없음'}</button>)}</div>
              </div>
            )}
          </Disclosure>
          <div className="hint">텔레그램에서 ✅ 를 누른 저점만 AI 자동매매 사용자 전원에게 진입(1번)·불타기(2·3번) 신호로 나가요. 🗑 취소는 본절, 🗑 리셋은 전량 정리예요.</div>
        </>
      )}</LoadSlot>
    </div>
  );
}
