import type { AdminCopyResponse, CopyApplyMasterRequest, CopyDashboardResponse, CopyExecution, CopyFollowRequest, CopyFollowSettings, CopyMasterHide, CopyMasterProfile, CopyMasterStatus, CopyStateResponse, AdminAutoBalancesResponse, AutoSettings, AutoStateResponse, AutoSignal, AdminPartner, AdminPartnerApplication, PartnerApplication, PartnerApplyRequest, PartnerStatus, AppState, Kline, KycAdminItem, PartnerMembersResponse, KycStatus, KycSubmitRequest, LoginRequest, Me, OpenOrderRequest, OpenOrderResult, SaveKeysRequest, Settings, SignupRequest, Symbol, TradeHistoryResponse, UpdateTpSlRequest } from '@easy-futures/shared';

export interface AdminBotState {
  telegramConfigured: boolean; adminChatConfigured: boolean; supportedCoins: string[]; supportedTfs: string[];
  watches: Record<string, string[]>;
  chains: Record<string, { id: number; seq: number; tsMs: number; low: number; status: 'proposed' | 'confirmed' }[]>;
  states: { coin: string; tf: string; lastEvalMs: number; lastPollAt: number | null; lastError: string | null }[];
  settings: { relay: boolean; leverage: number; tpR: number; tfs: string[] };
  engine: { alarm: number | null; lastTick?: number; webhook?: { at: number; url: string } } | null;
}
export interface AdminAutoUser { userId: number; loginId: string; uid: string | null; enabled: boolean; pct: number; maxLeverage: number; appliedAt: number | null; note: string | null }

export class ApiError extends Error {
  /** detail = 서버가 code 와 함께 붙인 부가 정보 (예: COPY_SYMBOL_LOCKED → { symbol, masterNickname }) */
  constructor(message: string, public status: number, public code?: string | number, public detail?: unknown) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 15000);
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, ...init });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError('응답이 늦어요. 주문이 들어갔는지 "내 상태"에서 확인한 뒤 다시 시도해 주세요.', 0, 'TIMEOUT');
    throw new ApiError('서버에 연결할 수 없어요. 인터넷을 확인해 주세요.', 0);
  } finally { window.clearTimeout(timer); }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok) {
    const b = body as { error?: string; code?: string | number; detail?: unknown } | null;
    throw new ApiError(b?.error ?? `오류가 났어요 (${res.status})`, res.status, b?.code, b?.detail);
  }
  return body as T;
}

export const api = {
  state: () => req<AppState>('/api/state'),
  klines: (symbol: Symbol, step = 15, limit = 96) => req<Kline[]>(`/api/klines?symbol=${symbol}&step=${step}&limit=${limit}`),
  // clientOrderId: 시도마다 새로 만드는 표식. 응답이 늦어 다시 눌러도 같은 주문인지 서버가 가릴 수 있게 (지금은 서버가 무시)
  // force: 고수 따라하기로 들어간 종목을 직접 주문할 때 409 COPY_SYMBOL_LOCKED 를 확인 창 뒤 넘기는 표식 (lib/copyLock.ts)
  open: (r: OpenOrderRequest & { clientOrderId?: string; force?: boolean }) => req<OpenOrderResult>('/api/order/open', { method: 'POST', body: JSON.stringify(r) }),
  close: (symbol: Symbol, force?: boolean) => req<{ ok: true }>('/api/position/close', { method: 'POST', body: JSON.stringify(force ? { symbol, force: true } : { symbol }) }),
  tpsl: (r: UpdateTpSlRequest & { force?: boolean }) => req<{ ok: true }>('/api/position/tpsl', { method: 'POST', body: JSON.stringify(r) }),
  settings: () => req<Settings>('/api/settings'),
  // autoDisabled: 거래 모드를 바꾸면서(관리자 연습 엔진 전환) AI 자동매매가 함께 꺼졌을 때 서버가 알려줌 (없을 수도 있음)
  saveSettings: (s: Partial<Settings>) => req<Settings & { autoDisabled?: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  paperReset: () => req<{ ok: true }>('/api/paper/reset', { method: 'POST' }), // 관리자 전용 (연습 엔진 지갑 초기화)
  history: (days = 30) => req<TradeHistoryResponse>(`/api/history?days=${days}`),
  me: () => req<Me>('/api/auth/me'),
  auto: () => req<AutoStateResponse>('/api/auto'),
  autoApply: (r: Partial<AutoSettings> & { agree: true; autoTermsVersion: string }) => req<{ ok: true; status: string }>('/api/auto/apply', { method: 'POST', body: JSON.stringify(r) }),
  autoSettings: (r: Partial<AutoSettings>) => req<AutoSettings>('/api/auto/settings', { method: 'PUT', body: JSON.stringify(r) }),
  autoPanic: () => req<{ ok: true; closed: string[]; failed: string[] }>('/api/auto/panic', { method: 'POST' }),
  adminBot: () => req<AdminBotState>('/api/admin/bot'),
  adminBotWatch: (r: { coin: string; tfs?: string[]; action: 'add' | 'remove' }) => req<{ ok: true }>('/api/admin/bot/watch', { method: 'POST', body: JSON.stringify(r) }),
  adminBotSettings: (r: Partial<AdminBotState['settings']>) => req<AdminBotState['settings']>('/api/admin/bot/settings', { method: 'PUT', body: JSON.stringify(r) }),
  adminBotPoll: () => req<{ ok: true }>('/api/admin/bot/poll', { method: 'POST' }),
  adminBotWebhook: () => req<{ ok: boolean }>('/api/admin/bot/webhook', { method: 'POST' }),
  adminAuto: () => req<{ pending: AdminAutoUser[]; approved: AdminAutoUser[]; suspended: AdminAutoUser[]; rejected?: AdminAutoUser[]; signals: AutoSignal[]; signalSecretSet: boolean }>('/api/admin/auto'),
  adminAutoBalances: () => req<AdminAutoBalancesResponse>('/api/admin/auto/balances'),
  adminSignalExecutions: (id: string) => req<{ signal: AutoSignal; executions: { userId: number; loginId: string; mode: 'paper' | 'live'; status: 'ok' | 'skipped' | 'failed'; detail: string | null; orderId: string | null; createdAt: number }[] }>(`/api/admin/auto/signals/${encodeURIComponent(id)}/executions`),
  adminSignalRerun: (id: string) => req<{ ok: true; result: { followers: number; ok: number; fail: number; skipped: number } }>(`/api/admin/auto/signals/${encodeURIComponent(id)}/rerun`, { method: 'POST' }),
  adminAutoDecide: (userId: number, action: 'approve' | 'suspend' | 'reject', note?: string) => req<{ ok: true }>(`/api/admin/auto/users/${userId}`, { method: 'POST', body: JSON.stringify({ action, note }) }),
  adminAutoSignal: (r: { symbol: string; action: 'open' | 'close'; direction?: string; leverage?: number; slRoi?: number; tpRoi?: number; note?: string }) => req<{ ok: true; id: string; result: { followers: number; ok: number; fail: number; skipped: number } }>('/api/admin/auto/signal', { method: 'POST', body: JSON.stringify(r) }),
  changePassword: (currentPassword: string, newPassword: string) => req<{ ok: true }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  agreeTerms: (version: string) => req<{ ok: true }>('/api/auth/agree-terms', { method: 'POST', body: JSON.stringify({ version }) }),
  deleteAccount: (password: string) => req<{ ok: true }>('/api/auth/delete-account', { method: 'POST', body: JSON.stringify({ password }) }),
  adminResetPassword: (loginId: string) => req<{ ok: true; loginId: string; tempPassword: string }>('/api/admin/users/reset-password', { method: 'POST', body: JSON.stringify({ loginId }) }),
  partnerMembers: () => req<PartnerMembersResponse>('/api/partner/members'),
  partnerAddMember: (uid: string) => req<{ ok: true; loginId: string }>('/api/partner/members', { method: 'POST', body: JSON.stringify({ uid }) }),
  partnerRemoveMember: (userId: number) => req<{ ok: true }>(`/api/partner/members/${userId}`, { method: 'DELETE' }),
  partnerApplication: () => req<{ status: PartnerStatus; application: PartnerApplication | null }>('/api/partner/apply'),
  partnerApply: (r: PartnerApplyRequest) => req<{ ok: true; status: PartnerStatus }>('/api/partner/apply', { method: 'POST', body: JSON.stringify(r) }),
  adminPartners: () => req<{ partners: AdminPartner[]; applications: AdminPartnerApplication[] }>('/api/admin/partners'),
  adminDecidePartner: (userId: number, action: 'approve' | 'reject', note?: string) => req<{ ok: true; status: string; code: string | null }>(`/api/admin/partners/applications/${userId}`, { method: 'POST', body: JSON.stringify({ action, note }) }),
  adminRemovePartner: (userId: number) => req<{ ok: true }>(`/api/admin/partners/${userId}`, { method: 'DELETE' }),
  adminCreatePartner: (loginId: string) => req<{ ok: true; code: string; loginId: string }>('/api/admin/partners', { method: 'POST', body: JSON.stringify({ loginId }) }),
  submitKyc: (r: KycSubmitRequest) => req<{ ok: true; status: KycStatus }>('/api/kyc', { method: 'POST', body: JSON.stringify(r) }),
  adminKycList: (status: KycStatus = 'pending') => req<{ items: KycAdminItem[] }>(`/api/admin/kyc?status=${status}`),
  adminKycDecide: (userId: number, action: 'approve' | 'reject', note?: string) => req<{ ok: true; status: KycStatus }>(`/api/admin/kyc/${userId}`, { method: 'POST', body: JSON.stringify({ action, note }) }),
  signup: (r: SignupRequest) => req<Me>('/api/auth/signup', { method: 'POST', body: JSON.stringify(r) }),
  login: (r: LoginRequest) => req<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify(r) }),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  saveKeys: (r: SaveKeysRequest) => req<{ ok: true; apiKeyPreview: string }>('/api/keys', { method: 'PUT', body: JSON.stringify(r) }),
  deleteKeys: () => req<{ ok: true }>('/api/keys', { method: 'DELETE' }),
  // ---- 카피 트레이딩 (고수 따라하기) — docs/copy-trading.md §5 ----
  copy: () => req<CopyStateResponse>('/api/copy'),
  copyMasterApply: (r: CopyApplyMasterRequest) => req<{ ok: true; status: CopyMasterStatus }>('/api/copy/master/apply', { method: 'POST', body: JSON.stringify(r) }),
  copyMasterIntro: (intro: string) => req<{ ok: true }>('/api/copy/master', { method: 'PUT', body: JSON.stringify({ intro }) }),
  // 공개 숨김(팔로워 수·거래 횟수·승률·30일 수익률·최근 거래): 바꾼 항목만 보내면 나머지는 그대로
  copyMasterHide: (hide: Partial<CopyMasterHide>) => req<{ ok: true; hide: CopyMasterHide }>('/api/copy/master/hide', { method: 'PUT', body: JSON.stringify({ hide }) }),
  copyMaster: (id: number) => req<CopyMasterProfile>(`/api/copy/masters/${id}`),
  copyFollow: (r: CopyFollowRequest) => req<{ ok: true; followId: number }>('/api/copy/follow', { method: 'POST', body: JSON.stringify(r) }),
  // 재동의(특약 버전만 바뀐 경우)도 같은 PUT 으로: agree + copyTermsVersion 을 함께 보낸다
  copyFollowSettings: (r: Partial<CopyFollowSettings> & { agree?: true; copyTermsVersion?: string }) => req<{ ok: true }>('/api/copy/follow', { method: 'PUT', body: JSON.stringify(r) }),
  // leftovers = 멈출 때 정리하지 못해 남은 포지션 수 (GET /api/copy 의 follow.leftovers 로 목록이 온다)
  copyUnfollow: (closePositions: boolean) => req<{ ok: true; closed?: boolean; leftovers?: number; note?: string }>('/api/copy/unfollow', { method: 'POST', body: JSON.stringify({ closePositions }) }),
  copyLeftoversAck: () => req<{ ok: true; acked: number }>('/api/copy/leftovers/ack', { method: 'POST' }),
  copyExecutions: () => req<{ executions: CopyExecution[] }>('/api/copy/executions'),
  copyDashboard: () => req<CopyDashboardResponse>('/api/copy/master/dashboard'),
  copyEventExecutions: (id: string) => req<{ executions: (CopyExecution & { loginId: string })[] }>(`/api/copy/master/events/${encodeURIComponent(id)}/executions`),
  adminCopy: () => req<AdminCopyResponse>('/api/admin/copy'),
  adminCopyMasterDecide: (userId: number, action: 'approve' | 'reject' | 'suspend', note?: string) => req<{ ok: true }>(`/api/admin/copy/masters/${userId}`, { method: 'POST', body: JSON.stringify({ action, note }) }),
  adminCopyFollowStop: (id: number) => req<{ ok: true }>(`/api/admin/copy/follows/${id}/stop`, { method: 'POST' }),
  adminCopyMasterKick: (userId: number) => req<{ ok: true }>(`/api/admin/copy/masters/${userId}/kick`, { method: 'POST' }),
  adminCopyPauseGlobal: (global: boolean) => req<{ ok: true }>('/api/admin/copy/pause', { method: 'POST', body: JSON.stringify({ global }) }),
  adminCopyPauseMaster: (userId: number, paused: boolean) => req<{ ok: true }>(`/api/admin/copy/masters/${userId}/pause`, { method: 'POST', body: JSON.stringify({ paused }) }),
  adminCopyResetStats: (userId: number, which: 'roi' | 'winRate' | 'recent' | 'all') => req<{ ok: true; which: string }>(`/api/admin/copy/masters/${userId}/reset-stats`, { method: 'POST', body: JSON.stringify({ which }) }),
};
