// Worker 바인딩 타입. wrangler.toml 과 맞춰 유지한다.
import type { Mode } from '@easy-futures/shared';

export interface Env {
  DB: D1Database;
  PAPER: DurableObjectNamespace;
  AUTO: DurableObjectNamespace;    // 자동매매 실행기 (AutoTrader)
  BOT: DurableObjectNamespace;     // 저점 카운팅 봇 감시 루프 (BottomWatcher)
  MASTER: DurableObjectNamespace;  // 카피: 마스터 계좌 감시 (MasterWatcher, 마스터당 1개)
  COPY: DurableObjectNamespace;    // 카피: 팔로워 팬아웃 실행 (CopyTrader, global + shard-N)
  RATE?: DurableObjectNamespace;   // 거래소 요청 관문 (RateGate, 싱글턴) — 공용 한도 초과 방지
  RATE_LIMITS?: string;            // 관문 버킷별 2초 창 허용 횟수 JSON (선택)
  ASSETS?: Fetcher;
  MASTER_KEY: string;      // 32바이트 base64 (AES-256-GCM 마스터 키) — wrangler secret
  MASTER_KEY_PREV?: string; // 키 교체 중 이전 키 (교체 완료 후 삭제) — wrangler secret
  INVITE_CODE: string;     // 가입 초대 코드(쉼표로 여러 개) — wrangler secret
  ADMIN_LOGIN_IDS?: string;
  AUTO_SIGNAL_SECRET?: string;  // 봇 → 서버 신호 서명 비밀키 — wrangler secret // 신분증 승인 권한 아이디(쉼표 구분) — wrangler secret
  TELEGRAM_BOT_TOKEN?: string;      // 저점 봇 텔레그램 토큰 — wrangler secret (없으면 봇 비활성)
  TELEGRAM_ADMIN_CHAT_ID?: string;  // 봇을 조작할 유일한 chat id — wrangler secret
  TELEGRAM_API_BASE?: string;       // 테스트용 Bot API 주소 대체
  BOT_CANDLE_URL?: string;          // 테스트용 캔들 API 주소 대체
  BOT_WEBHOOK_BASE?: string;        // 텔레그램 웹훅 기본 주소. 없으면 https://<CANONICAL_HOST>, 둘 다 없으면 웹훅 등록 안 함
  CANONICAL_HOST?: string;          // 정식 도메인 (wrangler.toml [vars]). 있으면 workers.dev·www 접속을 이 주소로 보낸다. 다른 계정 배포에서는 비운다
  USDT_KRW_DEFAULT: string;
  PAPER_START_BALANCE: string;
  PAPER_FEED?: string;     // 'off' 면 시세 피드 비활성(테스트용)
  ALLOW_PAPER?: string;    // 'on' 이면 누구나 연습(paper) 모드 사용 가능 + 새 사용자 기본 모드 paper (테스트·개발 전용, wrangler.toml 에는 넣지 않는다). 없으면 관리자만 (2026-09-18 연습 모드 제품에서 제거)
}

/** 연습 모드가 이 배포 전체에 열려 있는지 (테스트·개발 전용 플래그) */
export function paperEnabled(env: Pick<Env, 'ALLOW_PAPER'>): boolean {
  return env.ALLOW_PAPER === 'on';
}
/** 새 사용자의 기본 모드. 제품은 실거래(live) — 연습은 ALLOW_PAPER=on 인 테스트·개발 환경에서만 기본값 */
export function defaultMode(env: Pick<Env, 'ALLOW_PAPER'>): Mode {
  return paperEnabled(env) ? 'paper' : 'live';
}

export function numVar(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : def;
}
