import React, { useEffect, useState } from 'react';

type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** 기기·브라우저를 알아내 가장 쉬운 설치 방법을 보여준다. */
export function detectEnv() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const inApp = /kakaotalk|instagram|fbav|fban|line\/|naver\(inapp|whale|daumapps|snapchat|twitter|wv\)/i.test(ua) || (isIOS && !/safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua));
  const iosChrome = isIOS && /crios/i.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  return { isIOS, isAndroid, inApp, iosChrome, standalone };
}

/** 카카오톡·인스타 등 앱 안 브라우저에서 진짜 브라우저로 넘기는 링크 */
export function openInRealBrowser() {
  const { isIOS, isAndroid } = detectEnv();
  const url = location.href.split('#')[0];
  if (isIOS) { location.href = 'x-safari-' + url; return; }
  if (isAndroid) { location.href = `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`; return; }
  window.open(url, '_blank');
}

const KEY = 'ef.installHidden';

export function InstallBanner({ forceShow = false }: { forceShow?: boolean }) {
  const [evt, setEvt] = useState<BIP | null>(null);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  const env = detectEnv();
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setEvt(e as BIP); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (env.standalone) return forceShow ? <div className="banner ok">이미 홈 화면에 앱으로 설치되어 있어요 ✅</div> : null;
  if (hidden && !forceShow) return null;
  const hide = () => { setHidden(true); try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };

  const Box = ({ children }: { children: React.ReactNode }) => (
    <div className="card" style={{ background: '#111', color: '#fff', borderColor: '#111' }}>
      <div style={{ fontWeight: 900, fontSize: '1.05rem', marginBottom: '0.5rem' }}>📱 홈 화면에 앱처럼 추가하기</div>
      {children}
      {!forceShow && <button className="btn small ghost" style={{ color: '#fff', borderColor: '#555', marginTop: '0.6rem' }} onClick={hide}>나중에 할게요</button>}
    </div>
  );

  // 1) 앱 안 브라우저(카카오톡 등): 설치가 안 되므로 진짜 브라우저로 보낸다
  if (env.inApp) {
    return (
      <Box>
        <div style={{ lineHeight: 1.5 }}>지금은 <b>다른 앱 안에서 열린 화면</b>이라 홈 화면에 추가할 수 없어요. 아래 버튼을 누르면 {env.isIOS ? 'Safari' : 'Chrome'}에서 열려요.</div>
        <button className="btn" style={{ marginTop: '0.6rem', background: '#fff', color: '#111', borderColor: '#fff' }} onClick={openInRealBrowser}>{env.isIOS ? 'Safari' : 'Chrome'}로 열기 →</button>
        <div className="small" style={{ marginTop: '0.4rem', opacity: 0.8 }}>안 열리면 오른쪽 위 ⋯ 메뉴에서 "{env.isIOS ? 'Safari로 열기' : '다른 브라우저로 열기'}"를 눌러 주세요.</div>
      </Box>
    );
  }
  // 2) 안드로이드 Chrome: 버튼 하나로 설치
  if (evt) {
    return (
      <Box>
        <div style={{ lineHeight: 1.5 }}>버튼 한 번이면 끝나요. 누른 뒤 뜨는 창에서 <b>설치</b>를 누르세요.</div>
        <button className="btn" style={{ marginTop: '0.6rem', background: '#fff', color: '#111', borderColor: '#fff', minHeight: '4rem', fontSize: '1.15rem' }}
          onClick={async () => { await evt.prompt(); const r = await evt.userChoice; if (r.outcome === 'accepted') hide(); }}>홈 화면에 추가 (한 번에)</button>
      </Box>
    );
  }
  // 3) 아이폰: 애플 정책상 버튼으로 설치 불가 → 그림 순서 안내
  if (env.isIOS) {
    const shareWhere = env.iosChrome ? '오른쪽 위 ⋯ (점 세 개)' : '화면 아래 가운데';
    return (
      <Box>
        <div className="small" style={{ opacity: 0.85, marginBottom: '0.5rem' }}>아이폰은 애플 규칙 때문에 버튼 한 번으로는 안 되고, 아래 3단계면 됩니다.</div>
        <Step n={1} text={<>{shareWhere}의 <b>공유 버튼</b>을 누르세요</>} icon={<ShareIcon />} />
        <Step n={2} text={<>목록을 아래로 내려 <b>"홈 화면에 추가"</b>를 누르세요</>} icon={<PlusSquareIcon />} />
        <Step n={3} text={<>오른쪽 위 <b>"추가"</b>를 누르면 끝!</>} icon={<CheckIcon />} />
      </Box>
    );
  }
  // 4) 그 외(안드로이드 다른 브라우저 등)
  if (!forceShow) return null;
  return (
    <Box>
      <div style={{ lineHeight: 1.5 }}>브라우저 메뉴(⋮)에서 <b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b>를 누르세요. Chrome에서 열면 버튼 하나로 설치할 수 있어요.</div>
      <button className="btn" style={{ marginTop: '0.6rem', background: '#fff', color: '#111', borderColor: '#fff' }} onClick={openInRealBrowser}>Chrome으로 열기 →</button>
    </Box>
  );
}

function Step({ n, text, icon }: { n: number; text: React.ReactNode; icon: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.45rem 0', borderTop: '1px solid #333' }}>
      <span style={{ width: '1.7rem', height: '1.7rem', borderRadius: '50%', background: '#fff', color: '#111', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{n}</span>
      <span style={{ flex: 'none', width: '2rem', height: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#2a2a2a', borderRadius: 8 }}>{icon}</span>
      <span style={{ lineHeight: 1.4 }}>{text}</span>
    </div>
  );
}
const ShareIcon = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></svg>);
const PlusSquareIcon = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" /></svg>);
const CheckIcon = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>);
