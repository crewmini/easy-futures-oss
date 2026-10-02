// 공용 타입: 서버(API 응답)와 웹(화면)이 이 계약만 공유한다.

export type Symbol = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT';
export const SYMBOLS: Symbol[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
export const SYMBOL_LABEL: Record<Symbol, { name: string; short: string; coin: string }> = {
  BTCUSDT: { name: '비트코인', short: 'BTC', coin: 'BTC' },
  ETHUSDT: { name: '이더리움', short: 'ETH', coin: 'ETH' },
  SOLUSDT: { name: '솔라나', short: 'SOL', coin: 'SOL' },
};

export type Direction = 'long' | 'short'; // long=오른다에 걸기, short=내린다에 걸기
/** 'paper'(연습) 는 2026-09-18 부터 제품에서 제거 — 관리자·테스트(ALLOW_PAPER=on) 전용 내부 값. 일반 사용자는 항상 'live' */
export type Mode = 'paper' | 'live';

export interface ContractInfo {
  symbol: Symbol;
  contractSize: number;   // 1계약 = 몇 코인 (BTC 0.001)
  pricePrecision: number; // 가격 최소 단위 (0.1)
  volPrecision: number;   // 계약 수 단위 (1)
  minVolume: number;      // 최소 계약 수
  maxLeverage: number;    // 거래소 최대 배율
}

export interface Price {
  last: number;
  mark: number;
  change24hPct?: number; // 24시간 등락률 (%)
  updatedAt: number;
}

export interface Wallet {
  currency: 'USDT';
  available: number;   // 쓸 수 있는 돈
  equity: number;      // 총 자산(미실현 포함)
  unrealized: number;  // 지금 팔면 손익 합계
  positionMargin: number; // 포지션에 묶인 돈
}

export interface Position {
  symbol: Symbol;
  direction: Direction;
  contracts: number;        // 계약 수
  coinAmount: number;       // 코인 수량 = contracts × contractSize
  entryPrice: number;       // 평균 진입가(평단)
  markPrice: number;
  leverage: number;
  marginUsdt: number;       // 내 돈 사용분
  notionalUsdt: number;     // 포지션 가치
  unrealizedPnl: number;    // 지금 팔면 손익 (USDT)
  unrealizedPct: number;    // 내 돈 대비 %
  liquidationPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  openedAt: number;
  tpslUnknown?: true;       // 실거래: 손절·익절 플랜 주문 조회가 실패해 stopLossPrice/takeProfitPrice 를 모름 (없음이 아님 — 감시자는 직전 값을 유지)
  copy?: { masterNickname: string };   // 고수 따라하기로 들어간 포지션(장부 copy_positions 에 있음). 웹은 배지 + 직접 주문 시 확인 (2026-09-22)
}

export interface Settings {
  mode: Mode;
  maxLeverage: number;     // 앱에서 허용하는 최대 배율 (기본 10)
  maxAmountUsdt: number;   // 1회 최대 금액 (기본 500)
  usdtKrw: number;         // 표시용 환율 (기본 1380)
}

export interface AppState {
  mode: Mode;
  connected: boolean;      // 거래소/시세 연결 상태
  wallet: Wallet;
  positions: Position[];
  contracts: Record<Symbol, ContractInfo>;
  prices: Record<Symbol, Price>;
  settings: Settings;
  serverTime: number;
  needsSetup?: { kyc: boolean; apiKey: boolean };   // 실거래인데 아직 못 갖춘 것 (true = 빠짐). 있으면 wallet 은 0, positions 빈 배열, connected false → 웹은 온보딩 카드
  exchangeError?: string;  // 실거래: 거래소 조회 실패(키 거절·바쁨·연결 실패·키 복호화 실패). 있으면 connected false, wallet 0, positions 빈 배열 — 시세는 그대로. 200 으로 온다 (2026-09-18)
  priceError?: string;     // 시세를 못 받았을 때('시세 지연'). prices 는 빈 객체(각 종목 0) — 지갑·포지션은 그대로 (2026-09-18)
}

export interface OpenOrderRequest {
  symbol: Symbol;
  direction: Direction;
  amountUsdt: number;        // 내 돈 (마진)
  leverage: number;
  stopLossPrice: number;     // 필수 (화면 계산값, 서버 검증·폴백용)
  takeProfitPrice?: number | null;
  stopLossRoiPct?: number | null;    // 내 돈 기준 손절 % (있으면 체결가 기준으로 서버가 재계산)
  takeProfitRoiPct?: number | null;  // 내 돈 기준 익절 %
}

export interface OpenOrderResult {
  orderId: string;
  contracts: number;
  coinAmount: number;
  entryPrice: number | null;        // 실제 체결(평단). 즉시 알 수 없으면 null
  stopLossPrice?: number | null;    // 체결가 기준으로 최종 등록된 손절가
  takeProfitPrice?: number | null;  // 최종 등록된 익절가
  adjusted?: boolean;               // 체결가 기준 재계산으로 값이 바뀌었는지
  fillPrice?: number | null;        // 이번 주문만의 체결 평균가 (불타기면 평단과 다르다). 모르면 null
}

export interface ClosePositionRequest { symbol: Symbol }
export interface UpdateTpSlRequest {
  symbol: Symbol;
  stopLossPrice?: number | null;   // undefined=변경 없음, null=삭제
  takeProfitPrice?: number | null;
}

export interface Kline { t: number; o: number; h: number; l: number; c: number; v: number }

export interface ApiError { error: string; code?: string | number; detail?: unknown }

// ---- 계산 유틸 (서버·웹 공용) ----

/** 금액·배율·가격으로 계약 수 계산. 최소/단위 반영. */
export function calcContracts(amountUsdt: number, leverage: number, price: number, c: ContractInfo): number {
  if (!(amountUsdt > 0) || !(leverage > 0) || !(price > 0)) return 0;
  const raw = (amountUsdt * leverage) / (price * c.contractSize);
  const step = c.volPrecision > 0 ? c.volPrecision : 1;
  const n = Math.floor(raw / step) * step;
  return n >= c.minVolume ? n : 0;
}

/** 격리마진 강제정리가 근사치. mmr=유지증거금률(기본 0.5%). */
export function estimateLiquidation(entry: number, leverage: number, direction: Direction, mmr = 0.005): number {
  return direction === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

/** 손익(USDT). */
export function calcPnl(entry: number, mark: number, coinAmount: number, direction: Direction): number {
  const diff = direction === 'long' ? mark - entry : entry - mark;
  return diff * coinAmount;
}

/** 가격을 precision 단위로 반올림. */
export function roundToPrecision(price: number, precision: number): number {
  if (!(precision > 0)) return price;
  const decimals = Math.max(0, Math.ceil(-Math.log10(precision)));
  return Number((Math.round(price / precision) * precision).toFixed(decimals));
}

/** 진입가 대비 %로 손절/익절가 계산. pct는 양수(예: 3 → 3%). */
export function priceAtPct(entry: number, pct: number, direction: Direction, kind: 'sl' | 'tp'): number {
  const sign = (direction === 'long') === (kind === 'tp') ? 1 : -1;
  return entry * (1 + (sign * pct) / 100);
}

// ---- 인증/계정 ----
/** 현재 약관 버전. 바꾸면 모든 회원이 다음 접속 때 다시 동의해야 한다. */
export const TERMS_VERSION = '2026-09-07';
export const AUTO_TERMS_VERSION = '2026-09-08';   // 자동매매 특약 버전 (web/src/content/auto-terms.ts)
export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type KycDocType = 'id_card' | 'driver_license' | 'passport';
export interface Me {
  loginId: string;
  hasApiKey: boolean;
  apiKeyPreview: string | null;
  mode: Mode;
  uid: string | null;        // 거래소 UID (9로 시작하는 8자리)
  kycStatus: KycStatus;      // 신분증 인증 상태
  kycNote: string | null;    // 거절 사유
  isAdmin: boolean;
  affiliateCode: string | null;  // 이 계정이 제휴사면 고유 코드
  partnerStatus: PartnerStatus;  // 제휴사 신청 상태
  mustChangePassword: boolean;   // 임시 비밀번호로 로그인함 → 새 비밀번호 설정 필요
  termsOutdated: boolean;        // 약관이 바뀌어 재동의 필요
  autoStatus: AutoStatus;        // 자동매매 자격 상태
}
export type PartnerStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'removed';
export interface PartnerApplyRequest { company: string; name: string; phone: string }
export interface PartnerApplication { company: string; name: string; phone: string; submittedAt: number; note: string | null }
export interface AdminPartnerApplication { userId: number; loginId: string; uid: string | null; company: string; name: string; phone: string; submittedAt: number }
export interface SignupRequest { loginId: string; password: string; inviteCode?: string; uid: string; termsAgreed: boolean; affiliateCode?: string; termsVersion?: string }  // inviteCode·affiliateCode 는 선택
export interface PartnerMember {
  userId: number; loginId: string; uid: string | null; kycStatus: KycStatus; joinedAt: number;
  mode: Mode; hasApiKey: boolean; wallet: Wallet | null; positions: Position[]; error: string | null;
  autoStatus?: AutoStatus;   // 제휴사가 AI 자동매매 고객을 구분할 수 있게
}
export interface PartnerMembersResponse { members: PartnerMember[]; prices: Partial<Record<Symbol, Price>>; serverTime: number }
/** 관리자 AI 자동매매 카드: 승인 사용자별 실시간 선물 잔고 (서버 55초 캐시) */
export interface AdminAutoBalance { userId: number; loginId: string; mode: Mode; wallet: Wallet | null; positions: Position[]; error: string | null }
export interface AdminAutoBalancesResponse { balances: AdminAutoBalance[]; cachedAt: number; serverTime: number }
export interface AdminPartner { userId: number; loginId: string; code: string; members: number; createdAt: number; company: string | null; name: string | null; phone: string | null }
export interface KycSubmitRequest { docType: KycDocType; image: string } // image = data:image/jpeg;base64,...
export interface KycAdminItem { userId: number; loginId: string; uid: string | null; submittedAt: number | null; docType: KycDocType | null; status: KycStatus }
export interface LoginRequest { loginId: string; password: string }
export interface SaveKeysRequest { apiKey: string; apiSecret: string; memo: string }

// ---- 거래 내역 ----
export type TradeKind = 'open' | 'close' | 'sl' | 'tp' | 'auto' | 'liq';
export interface TradeHistoryItem {
  id: string;
  time: number;            // ms
  symbol: Symbol;
  kind: TradeKind;         // open=진입, close=직접 정리, sl/tp=손절/익절, auto=자동 정리(구분 불가), liq=강제정리
  direction: Direction;    // 포지션 방향
  contracts: number;
  coinAmount: number;
  price: number;           // 체결가
  pnl: number | null;      // 가격 차이 손익(USDT, 수수료 전). 진입은 null
  fee: number | null;      // 이 체결의 수수료
  openFee?: number | null; // 정리 행에만: 짝이 되는 진입 수수료 합
  netPnl?: number | null;  // 정리 행에만: pnl − 진입 수수료 − 정리 수수료
  leverage: number | null;
  orderId?: string | null;                 // 거래소 주문 id (자동매매 실행 기록과 연결)
  clientOrderId?: string | null;           // 주문 표식 — 'cp…' 로 시작하면 고수 따라하기 실행기가 낸 주문 (기록 누락과 무관하게 출처 판정)
  source?: TradeSource;                    // 이 거래가 속한 포지션 흐름의 출처: 자동매매 / 쉬운 거래(직접) / 혼합
  signalId?: string | null;                // 자동매매 진입이면 신호 id
}
export type TradeSource = 'auto' | 'manual' | 'mixed' | 'copy';   // copy = 카피 트레이딩(고수 따라하기)으로 들어간 흐름
export interface HistorySummary { realizedPnl: number; totalFees: number; netPnl: number; closedCount: number }
export interface DailyPnl { date: string; netPnl: number; totalFees: number; closedCount: number; auto: number; manual: number }  // date = KST YYYY-MM-DD
export interface TradeHistoryResponse {
  items: TradeHistoryItem[];   // 최신순
  days: number;
  realizedPnl: number;         // 기간 가격 차이 손익 합계(수수료 전)
  totalFees: number;           // 기간 수수료 합계
  netPnl: number;              // 실제 남은 돈 = realizedPnl − totalFees
  closedCount: number;         // 정리 횟수
  bySource: Record<'auto' | 'manual', HistorySummary> & { copy?: HistorySummary };   // 자동매매 / 쉬운 거래 / 카피 분리 합계 (혼합 흐름은 자동매매 쪽에)
  daily: DailyPnl[];           // 달력용 일별 순손익 (KST)
}

/**
 * 내 돈(증거금) 기준 손익률 → 가격. roiPct=10, leverage=5, long, 'sl' → 진입가 × (1 − 0.10/5).
 * 손절/익절 프리셋은 가격 변동률이 아니라 레버리지가 반영된 "내 돈 기준"으로 보여준다.
 */
export function priceAtRoi(entry: number, roiPct: number, leverage: number, direction: Direction, kind: 'sl' | 'tp'): number {
  const lev = leverage > 0 ? leverage : 1;
  return priceAtPct(entry, roiPct / lev, direction, kind);
}


// ---- 자동매매 (신호 따라가기) ----
export type AutoStatus = 'none' | 'pending' | 'approved' | 'suspended' | 'rejected';
export interface AutoSettings {
  enabled: boolean;
  pct: number;            // 신호당 내 돈의 N%
  maxLeverage: number;
  defaultSlRoi: number;   // 신호에 손절이 없으면 내 돈 기준 -N%
}
export interface AutoSignal {
  id: string;
  source: 'bot' | 'admin';
  symbol: Symbol;
  action: 'open' | 'add' | 'update' | 'close';   // open=진입, add=불타기(추가 진입), update=손절/익절 갱신, close=전량 정리
  direction: Direction | null;
  leverage: number | null;
  slRoi: number | null;
  tpRoi: number | null;
  slPrice: number | null;      // 절대 손절가(예: 직전 저점)
  tpPrice: number | null;      // 절대 익절가
  breakeven: boolean;          // 본절: 평단 위면 손절=평단, 평단 아래면 익절=평단
  note: string | null;
  createdAt: number;
  processedAt: number | null;
  followerCount: number | null;
  okCount: number | null;
  failCount: number | null;
}
export interface AutoExecution {
  id: number;
  signalId: string;
  mode: Mode;
  status: 'ok' | 'skipped' | 'failed';
  detail: string | null;
  createdAt: number;
  orderId?: string | null;
  pnl?: number | null;        // 이 진입이 속한 포지션 흐름의 실현 순손익 (아직 안 닫혔거나 모르면 null)
  closed?: boolean;           // 그 흐름이 완전히 정리됐는지
  signal?: Pick<AutoSignal, 'symbol' | 'action' | 'direction' | 'leverage' | 'note'>;
}
export interface AutoStateResponse {
  status: AutoStatus;
  settings: AutoSettings;
  agreedAt: number | null;
  note: string | null;
  autoTermsOutdated?: boolean;  // 특약이 바뀌어 다시 동의(재신청)해야 실행됨
  recentSignals: AutoSignal[];
  myExecutions: AutoExecution[];
}
export interface SignalIngestRequest {
  id: string; symbol: Symbol; action: 'open' | 'add' | 'update' | 'close'; direction?: Direction; leverage?: number;
  slRoi?: number; tpRoi?: number; slPrice?: number; tpPrice?: number; breakeven?: boolean; note?: string;
}

// ---------------- 카피 트레이딩 (고수 따라하기) — docs/copy-trading.md ----------------
export const COPY_TERMS_VERSION = '2026-09-18';     // 팔로워 특약 (web/src/content/copy-terms.ts)
export const MASTER_TERMS_VERSION = '2026-09-18';   // 마스터(고수) 약관
export type CopyMasterStatus = 'none' | 'pending' | 'approved' | 'suspended' | 'rejected';
export type CopyFollowStatus = 'active' | 'stopped';
export type CopyEventKind = 'open' | 'add' | 'reduce' | 'close' | 'tpsl' | 'leverage';   // tpsl = 마스터가 손절·익절을 바꿈, leverage = 배율을 바꿈 (열린 포지션에 그대로 반영)
export type CopyStopReason = 'user' | 'loss_limit' | 'master_suspended' | 'no_api_key' | 'mode_switch' | 'paper_switch' | 'kyc_rejected' | 'terms_outdated' | 'admin' | 'account_deleted';   // paper_switch = 옛 기록 호환(지금은 mode_switch)
/** 정리하지 못한 포지션(copy_leftovers) 사유: 팔로우 정지 사유 또는 loss_limit_partial(손실 한도 정리 일부 실패, 팔로우는 계속 재시도) */
export type CopyLeftoverReason = CopyStopReason | 'loss_limit_partial';
/** 따라하기가 멈출 때 정리되지 않고 남은 포지션 (D1 0024). 사용자가 확인(ack)하기 전까지 CopyFollowMe.leftovers 로 온다 */
export interface CopyLeftover { symbol: Symbol; direction: Direction; contracts: number; entryPrice: number; leverage: number; reason: CopyLeftoverReason; createdAt: number }
/** 고수 close 이벤트의 정리 사유 (감시 DO 가 거래소 주문 이력으로 최선 노력 분류). null = 미분류 */
export type CopyCloseReason = 'liquidation' | 'adl' | 'normal';
/** 팔로우 설정. copyAmount = 따라갈 돈(USDT), lossLimitPct = 따라갈 돈의 N% 잃으면 멈추고 전량 정리, slRoi = 진입마다 붙는 손절(내 돈 기준 %) */
export interface CopyFollowSettings { copyAmount: number; lossLimitPct: number; maxLeverage: number; slRoi: number }
export const DEFAULT_COPY_FOLLOW: CopyFollowSettings = { copyAmount: 100, lossLimitPct: 50, maxLeverage: 10, slRoi: 30 };
export const COPY_LIMITS = { copyAmountMin: 10, copyAmountMax: 1_000_000, lossLimitPct: [10, 95], maxLeverage: [1, 50], slRoi: [10, 95], nickname: [2, 12], introMax: 200 } as const;
/** 고수 공개 숨김 (D1 0021 hide_json). true = 다른 사용자에게 숨김. 고수 본인 대시보드·관리자는 항상 전부 본다 */
export interface CopyMasterHide { followers: boolean; trades: boolean; winRate: boolean; roi: boolean; recent: boolean }
export const DEFAULT_COPY_MASTER_HIDE: CopyMasterHide = { followers: false, trades: false, winRate: false, roi: false, recent: false };
export interface CopyMasterCard {
  userId: number; nickname: string; intro: string | null; since: number;
  followers?: number; days30Pnl?: number; days30Roi?: number; winRate?: number; trades?: number;   // 최근 30일, ROI 는 %, 승률 0~100. days30Pnl(USDT) 은 고수 본인 대시보드·관리자에만 (공개 카드는 비공개). 나머지는 고수가 hide 로 숨기면 공개 카드에서 빠진다
  hide: CopyMasterHide;   // 어떤 항목을 숨겼는지 (화면은 "비공개" 표기)
  positions: { symbol: Symbol; direction: Direction }[];   // 지금 들고 있는 방향만 (수량·금액 비공개)
}
export interface CopyMasterProfile extends CopyMasterCard {
  recent?: { closedAt: number; symbol: Symbol; direction: Direction; roiPct: number }[];   // 최근 마감 거래 10건 (금액 대신 내 돈 기준 %). hide.recent 면 빠진다
}
export interface CopyMasterMe { status: CopyMasterStatus; nickname: string | null; intro: string | null; note: string | null; appliedAt: number | null; masterTermsOutdated: boolean; hide: CopyMasterHide }
export interface CopyPositionView { symbol: Symbol; direction: Direction; contracts: number; entryPrice: number; leverage: number; markPrice: number; unrealizedPnl: number; openedAt: number; stopLossPrice?: number | null; takeProfitPrice?: number | null }
export interface CopyFollowMe {
  id: number; masterId: number; masterNickname: string; status: CopyFollowStatus; mode: Mode; settings: CopyFollowSettings;
  copyAmountNow: number; realizedPnl: number; unrealizedPnl: number; lossLimitUsed: number;   // lossLimitUsed 0~1 (손실 한도 대비 현재 손실 비율)
  positions: CopyPositionView[]; startedAt: number; stoppedAt: number | null; stopReason: CopyStopReason | null; copyTermsOutdated: boolean;
  leftovers?: CopyLeftover[];       // 이 팔로우가 멈출 때 정리하지 못한 포지션(미확인분). POST /api/copy/leftovers/ack 로 지운다 (2026-09-22)
  avgSlippagePct?: number | null;   // 최근 30일 내 체결(open/add/close 성공) 슬리피지 평균 %. 양수 = 팔로워에게 불리. 체결가 기록이 없으면 null
}
export interface CopyEligibility { kyc: boolean; live: boolean; apiKey: boolean; autoOn: boolean; termsCurrent: boolean }   // live 는 연습 모드 제거 후 일반 사용자에겐 항상 true (관리자·테스트 계정만 false 가능)
export interface CopyStateResponse { me: { master: CopyMasterMe | null; follow: CopyFollowMe | null; eligible: CopyEligibility }; masters: CopyMasterCard[]; serverTime: number }
export interface CopyApplyMasterRequest { nickname: string; intro: string; agree: true; masterTermsVersion: string }
export interface CopyFollowRequest extends CopyFollowSettings { masterId: number; agree: true; copyTermsVersion: string }
export interface CopyEvent {
  id: string; masterId: number; seq: number; symbol: Symbol; kind: CopyEventKind; direction: Direction;
  beforeContracts: number; afterContracts: number; price: number; leverage: number; masterEquity: number;
  slPrice?: number | null; tpPrice?: number | null;   // 이벤트 시점 마스터의 손절·익절 (open/add/tpsl 에서 팔로워에 그대로 복제)
  createdAt: number; processedAt: number | null; followerCount: number | null; okCount: number | null; failCount: number | null; skippedCount: number | null;
  closeReason?: CopyCloseReason | null;   // close 이벤트만: 고수가 강제정리(liquidation)/자동감축(adl)/직접(normal) 정리했는지. 팬아웃 뒤 채워지므로 처음엔 null (2026-09-22)
}
export interface CopyExecution {
  eventId: string; followerId: number; mode: Mode; status: 'ok' | 'failed' | 'skipped' | 'pending'; detail: string | null; orderId: string | null; contracts: number; createdAt: number;   // pending = 실행 중(중복 주문 방지 선점 행)
  event?: Pick<CopyEvent, 'symbol' | 'kind' | 'direction' | 'price' | 'closeReason'>; pnl?: number | null;
  fillPrice?: number | null;     // 팔로워 체결 평균가 (open/add/close 성공 시, 2026-09-22)
  slippagePct?: number | null;   // (체결가 − 이벤트 가격) / 이벤트 가격 × 100, 팔로워에게 불리하면 양수 (진입 롱: 비싸게 산 만큼, 정리 롱: 싸게 판 만큼)
}
export interface CopyFollowerRow {
  followId: number; maskedId: string; mode: Mode; copyAmount: number; copyAmountNow: number; realizedPnl: number; unrealizedPnl: number;
  positions: CopyPositionView[]; startedAt: number; lastExecution: { status: CopyExecution['status']; detail: string | null; createdAt: number; slippagePct?: number | null } | null;
}
export interface CopyDashboardResponse { followers: CopyFollowerRow[]; events: CopyEvent[]; stats: CopyMasterCard; watcher: { wsOk: boolean; lastPollAt: number | null; lastError: string | null }; serverTime: number }
export interface AdminCopyMaster { userId: number; loginId: string; nickname: string; intro: string | null; status: CopyMasterStatus; appliedAt: number | null; decidedAt: number | null; note: string | null; mode: Mode; hasApiKey: boolean; followers: number; paused?: boolean }   // paused = 운영자가 이 고수의 새 진입을 멈춤
export interface AdminCopyFollow { id: number; followerLoginId: string; masterNickname: string; status: CopyFollowStatus; mode: Mode; copyAmount: number; copyAmountNow: number; realizedPnl: number; startedAt: number; stoppedAt: number | null; stopReason: CopyStopReason | null; leftovers?: number }   // leftovers = 멈출 때 정리하지 못해 사용자 확인을 기다리는 포지션 수
export interface AdminCopyResponse { pending: AdminCopyMaster[]; approved: AdminCopyMaster[]; suspended: AdminCopyMaster[]; rejected: AdminCopyMaster[]; follows: AdminCopyFollow[]; events: CopyEvent[]; pausedGlobal?: boolean }   // pausedGlobal = 모든 고수의 새 진입 멈춤(킬 스위치)
