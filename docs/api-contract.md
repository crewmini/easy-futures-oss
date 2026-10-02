# 서버 ↔ 웹 API 계약 (v0.2, 다중 사용자)
모든 응답 JSON. 오류는 `{ error: string, code?, detail? }` + 4xx/5xx. 타입은 `shared/src/index.ts`.
인증: 세션 쿠키 `ef_session` (HttpOnly). `/api/auth/*` 외 모든 경로는 세션 없으면 **401** `{error:"로그인이 필요해요"}`.
없는 `/api/*` 주소(또는 있는 주소의 다른 메서드)는 **404** `{ error:'없는 주소예요', code:'NOT_FOUND' }` JSON (SPA HTML 이 아니다, 2026-09-18). 세션이 없으면 인증이 먼저라 401 이 온다.

## 인증
| 메서드/경로 | 요청 | 응답 |
|---|---|---|
| POST /api/auth/signup | `{ loginId, password, inviteCode }` | `Me` (쿠키 설정). loginId 3~20자 영숫자, password 6자 이상. `mode` 는 `live` (2026-09-18 연습 모드 제거). 아이디 중복은 조회·INSERT 경합까지 409 `DUPLICATE`, UID 중복 409 `DUPLICATE_UID` |
| POST /api/auth/login | `{ loginId, password }` | `Me` (쿠키 설정). 5회 실패 시 10분 잠금 → 423 `LOCKED`. 같은 IP 에서 실패 10분 30회 → 429 `TOO_MANY_ATTEMPTS`(해시 계산 전 거절, 성공 로그인은 안 셈). 관리자 임시 비밀번호가 24시간 지났으면 403 `TEMP_PW_EXPIRED` (2026-09-18) |
| POST /api/auth/logout | — | `{ ok: true }` |
| GET /api/auth/me | — | `Me` = `{ loginId, hasApiKey, apiKeyPreview: string|null, mode }` |

## API 키
| PUT /api/keys | `{ apiKey, apiSecret, memo }` | `{ ok: true, apiKeyPreview }` — 저장 전 거래소 `assets-detail`로 검증, 실패 시 400 "거래소가 키를 거절했어요: …" |
| DELETE /api/keys | — | `{ ok: true }` (mode 는 바꾸지 않는다. 키가 없는 실거래 사용자는 온보딩 상태로 돌아가 주문 API 가 400) |

## 거래 (사용자 컨텍스트)
| 메서드/경로 | 요청 | 응답 | 설명 |
|---|---|---|---|
| GET /api/health | — | `{ ok, serverTime }` | 인증 불필요 |
| GET /api/state | — | `AppState` | 웹이 3초마다 폴링. `mode`는 사용자 설정. 실거래에서 거래소 조회가 실패해도 **200** 이며 `connected:false` + `exchangeError`(아래) |
| GET /api/klines?symbol&step=15&limit=96 | — | `Kline[]` | 인증 불필요 |
| POST /api/order/open | `OpenOrderRequest & { clientOrderId?: string }` | `OpenOrderResult & { duplicate?: true }` | 시장가 진입 + 손절(필수)/익절(선택). `clientOrderId` 는 아래 "주문 표식" 참고 |
| POST /api/position/close | `{ symbol }` | `{ ok: true }` | 전량 정리 + TP/SL 취소 |
| POST /api/position/tpsl | `UpdateTpSlRequest` | `{ ok: true }` | |
| GET /api/settings | — | `Settings` | |
| PUT /api/settings | `Partial<Settings>` | `Settings` | `mode:'live'` 전환은 hasApiKey일 때만, 아니면 400. `mode:'paper'` 는 관리자(`ADMIN_LOGIN_IDS`) + `ALLOW_PAPER=on` 일 때만, 그 외에는 **400 `PAPER_DISABLED`** |
| POST /api/paper/reset | — | `{ ok: true }` | 내 연습 계좌 초기화 (관리자 연습 모드 전용) |

온보딩(2026-09-18, 연습 모드 제거): 일반 사용자는 `mode:'live'` 고정이며, 신분증 승인(`Me.kycStatus === 'approved'`) + API 키(`Me.hasApiKey`) 전까지 주문·포지션·자동매매·따라하기 시작 API 는 4xx 로 거절된다. 웹은 `Me` 의 두 값으로 홈 온보딩 카드("실거래 준비": 신분증 확인 → 거래소 연결)를 그린다.

검증(서버): leverage ∈ [1, settings.maxLeverage], amountUsdt ∈ (0, settings.maxAmountUsdt], 손절가는 long이면 현재가 미만·short이면 초과, 익절은 반대, 계약 수 0이면 400 "금액이 너무 적어요".

## AI 자동매매 (`/api/auto`) — 상세 `docs/auto-trading.md`
| PUT /api/auto/settings | `Partial<AutoSettings>` | `AutoSettings` | `enabled:true` 는 승인(403 `NOT_APPROVED`) + 실거래면 API 키 필수(**400 `NO_API_KEY`** '거래소 API 키를 먼저 연결해 주세요', 2026-09-18) + 고수 따라하기 중이면 409 `COPY_ACTIVE` |

## 고수 따라하기 (`/api/copy`) — 전체 목록은 `docs/copy-trading.md` §5
| 메서드/경로 | 요청 | 응답 | 설명 |
|---|---|---|---|
| GET /api/copy | — | `CopyStateResponse` | `masters: CopyMasterCard[]` — 다른 고수가 숨긴 항목(`followers/trades/winRate/days30Roi`)은 키 자체가 없고 `hide: CopyMasterHide` 로 무엇이 비공개인지만 온다. 내 카드는 전부 |
| GET /api/copy/masters/:id | — | `CopyMasterProfile` | 위와 같음 + `recent?`(고수가 숨기면 없음) |
| PUT /api/copy/master/hide | `{ hide: Partial<CopyMasterHide> }` | `{ ok, hide: CopyMasterHide }` | 고수 공개 숨김. true/false 만(400 `BAD_HIDE`), 고수 행 없으면 404 `NOT_MASTER`. 본인 대시보드 `stats`·관리자 카드는 계속 전부 본다 |

## 안정성 계약 (2026-09-18, 감사 B 항목)

### `AppState` 추가 필드 (둘 다 선택, 실거래만)
| 필드 | 뜻 | 웹이 할 일 |
|---|---|---|
| `exchangeError?: string` | 거래소 조회 실패. 응답은 **200**, `connected:false`, `wallet` 0, `positions` 빈 배열, `needsSetup` 없음. 시세는 그대로 | 홈 상단에 문장 그대로 띄우고 폴링은 계속 (3초). 문장: `거래소 키가 거절됐어요 (키를 다시 등록해 주세요)`(401/403) · `거래소가 잠시 바빠요`(429) · `거래소 연결 실패`(그 외) · `거래소 키를 읽을 수 없어요. 관리자에게 알려 주세요`(키 복호화 실패, 아래) |
| `priceError?: string` | 시세 DO(3초 타임아웃)와 거래소 REST 폴백이 모두 실패. `prices` 는 각 종목 0, `connected:false`. 지갑·포지션은 정상 | "시세 지연" 배지, 주문 버튼 비활성 |

키 복호화 실패(`KEY_DECRYPT_FAILED`): 키 행은 있는데 서버 MASTER_KEY 로 못 읽는 상태. `/api/state` 는 `needsSetup` 없이 `exchangeError` 로 알리고, 주문·정리·손절 변경·내역은 **503** `{ code:'KEY_DECRYPT_FAILED' }`. `PUT /api/keys` 로 새 키를 등록하면 덮어써서 풀린다(막지 않는다). 주의: `GET /api/auth/me` 의 `hasApiKey` 는 이 경우 아직 `false` 로 온다(routes/auth.ts 미수정) — 웹은 온보딩 카드 판단에 `AppState.needsSetup` 을 우선해야 한다.

### 주문 표식 `clientOrderId` (POST /api/order/open)
- 형식 `^[A-Za-z0-9_-]{8,32}$`, 틀리면 400 `BAD_CLIENT_ORDER_ID`. 없으면 서버가 만들어 거래소 `client_order_id` 로 보낸다.
- 웹은 **주문 시트를 열 때 하나 만들어 재시도에도 같은 값**을 보낸다(웹 15초 타임아웃 → "다시 시도" 포함). 서버는 표식이 왔을 때만 거래소 주문 이력을 1회 조회해, 같은 표식의 주문이 이미 있으면 **다시 내지 않고** 그 결과를 `duplicate:true` 로 돌려준다(`contracts`·`entryPrice`·`fillPrice` 는 체결 기준, `stopLossPrice`/`takeProfitPrice` 는 요청값, `adjusted:false`). 그 주문이 체결 없이 끝났으면 409 `NO_FILL` + `detail.duplicate:true` → 새 표식으로 다시 주문해도 된다.

### 주문 관련 오류 코드
| 상태 | code | 뜻 / 웹이 할 일 |
|---|---|---|
| 400 | `PRICE_STALE` | 시세가 60초 넘게 안 갱신됨. "시세가 오래돼 주문할 수 없어요. 잠시 후 다시" — 재시도는 같은 `clientOrderId` 로 |
| 409 | `ORDER_SENT_UNCONFIRMED` | **주문은 거래소에 들어갔는데** 체결 확인에 실패. `detail.orderId`(정리는 `detail.filled` 도). 절대 자동 재시도 금지 — "내 상태"를 새로고침해 포지션을 확인하도록 안내. 진입·정리(`/position/close`) 둘 다 |
| 409 | `NO_FILL` | 체결 0 (호가 부족). 잠시 후 재시도 |
| 503 | `PRICE_UNAVAILABLE` | 시세 엔진이 3초 안에 응답 없음(주문·손절 변경 경로). 잠시 후 재시도 |
| 503 | `ENGINE_UNAVAILABLE` | (연습 엔진 경로만) 엔진 응답 없음 |
| 503 | `KEY_DECRYPT_FAILED` | 위 "키 복호화 실패" |
| 503 | `RATE_LIMITED` | 거래소 429. `Retry-After` 헤더(초) 뒤 재시도 |

## 카피 운영 안전 (2026-09-22, D1 0024) — 상세 `docs/copy-trading.md` §10
| 메서드/경로 | 요청 | 응답 | 설명 |
|---|---|---|---|
| GET /api/copy | — | `CopyStateResponse` | `me.follow.leftovers?: CopyLeftover[]`(최근 팔로우가 멈출 때 정리하지 못한 포지션, 미확인분만: `{ symbol, direction, contracts, entryPrice, leverage, reason, createdAt }`, reason = `CopyStopReason | 'loss_limit_partial'`), `me.follow.avgSlippagePct?: number|null`(30일 평균 %, 양수 = 불리) |
| POST /api/copy/leftovers/ack | — | `{ ok, acked: number }` | 정리하지 못한 포지션 확인(화면에서 지움). 포지션 자체는 사용자가 직접 정리 |
| POST /api/copy/unfollow | `{ closePositions }` | `{ ok, closed, leftovers: number, … }` | `leftovers` = 남긴(정리 못 한) 포지션 수 |
| GET /api/copy/executions, GET /api/copy/master/events/:id/executions, 대시보드 `lastExecution` | — | `CopyExecution` | `fillPrice?`, `slippagePct?`(±(체결가−이벤트가)/이벤트가×100, 팔로워에게 불리하면 양수), `event.closeReason?`. 고수 강제정리로 정리된 close 는 detail 앞에 `고수 강제정리로 정리 · ` |
| `CopyEvent` | — | — | `closeReason?: 'liquidation' \| 'adl' \| 'normal' \| null` (close 만, 팬아웃 뒤 채워짐) |
| GET /api/admin/copy | — | `AdminCopyResponse` | `follows[i].leftovers?: number`(미확인 남은 포지션 수). `POST /admin/copy/follows/:id/stop` 응답에 `leftovers` |
| GET /api/state | — | `AppState` | `positions[i].copy?: { masterNickname }` — 고수 따라하기로 들어간 포지션(장부에 있음). 웹은 배지 |
| POST /api/order/open · /api/position/close · /api/position/tpsl | `+ force?: true` | 409 `COPY_SYMBOL_LOCKED` | 따라하기 중이고 같은 종목에 따라 들어간 장부가 있으면 거절(`detail: { symbol, masterNickname }`, 문장 "이 종목은 고수 따라하기로 들어간 포지션이 있어요. 직접 주문하면 손절이 겹칩니다 — 따라하기를 멈추거나 다른 종목을 이용해 주세요"). 웹은 확인 창 뒤 `force:true` 로 재요청 |
