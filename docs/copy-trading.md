# 카피 트레이딩 설계 (2026-09-18)

세 번째 기능. 홈 스위치는 **쉬운 거래 | AI 자동매매 | 카피 트레이딩**.
마스터 트레이더(검증된 사용자)가 자기 계좌에서 매매하면, 팔로워 계좌에 같은 방향·비례 크기로 거의 즉시 따라 들어간다.

## 1. 역할·자격
| 역할 | 자격 | 절차 |
|---|---|---|
| 마스터 | 신분증 승인 + 약관 최신 동의 + **API 키(실거래)** (연습 계정은 관리자 테스트 전용 — 2026-09-18 제품에서 연습 모드 제거) | 카피 탭 → "마스터 신청"(닉네임 2~12자, 소개 ≤200자, 마스터 약관 동의) → 관리자 승인 → 공개 목록에 노출 |
| 팔로워 | 신분증 승인 + 약관 최신 동의 + 카피 특약 동의 + API 키 (실거래만. 연습 팔로우는 제거, 관리자만 `ALLOW_PAPER=on` 으로 테스트) | 마스터 프로필 → "따라하기" → 투자금·손실 한도·최대 배율 → 시작 |

규칙
- 팔로워는 **한 번에 한 마스터만** 따른다. 카피가 켜져 있으면 AI 자동매매를 켤 수 없고, 반대도 같다(계좌 하나에 두 신호원이 섞이면 방향 충돌). 서버가 409 로 막는다.
- 마스터는 자기 자신을 따를 수 없다. 마스터가 팔로워가 될 수는 있다(다른 마스터를).
- 마스터 승인이 중지(suspended)되면 그 마스터의 팔로우는 전부 `stopped(master_suspended)` 로 바뀌고 **팔로워 포지션은 남긴다**(손절은 이미 걸려 있음). 화면에 "마스터가 중지돼 더 이상 따라가지 않아요. 열린 포지션은 직접 정리하세요" 안내.
- 마스터 API 키가 삭제·거부되면 마스터는 `suspended` (사유 기록) + 위와 같은 처리.
- 팔로워 API 키 삭제 / (관리자) 모드 전환 / 신분증 거절 / 약관 구버전 → 해당 팔로우 `stopped` (auto 의 disableAuto 와 같은 자리에서 호출).

## 2. 마스터 감시 (레이턴시 핵심) — `MasterWatcher` Durable Object (마스터 1명 = 인스턴스 1개, idFromName(`master-<userId>`))
- **1차: 거래소 개인 WebSocket** `wss://cloud-ws.wooxpro.com/user?protocol=1.1`. 로그인 `{"action":"access","args":[apiKey, ts, sign, "web"]}`, sign = `signWebSocketLogin(secret, ts, memo)` (이미 `server/src/sign.ts`). 구독 `futures/position`, `futures/order`.
  **WS 메시지는 파싱해서 믿지 않는다.** 어떤 메시지든 오면 "깨우기" 신호로만 쓰고 → 즉시 REST `position-v2`(`adapter.getAccount`)로 **정답을 다시 읽는다**. 메시지 형식이 문서와 달라도 정확성은 유지된다(레이턴시만 REST 1회 ≈ 200ms 추가).
- **2차: 폴링** 알람 2초(WS 살아 있으면 5초)마다 `getAccount`. WS 가 끊겨도 최대 2초 안에 잡는다. 관리자 연습 마스터는 폴링만(테스트용).
- **디프 → 이벤트**: 심볼별 직전 상태(`copy_master_state`)와 비교.
  | 변화 | kind | 팔로워 동작 |
  |---|---|---|
  | 0 → n | `open` | 진입 (손절 필수) |
  | n → m (m>n, 같은 방향) | `add` | 추가 진입, 비례 |
  | n → m (0<m<n) | `reduce` | 같은 비율(1−m/n)만큼 부분 정리 |
  | n → 0 | `close` | 전량 정리 |
  | 방향 전환 (롱→숏) | `close` 뒤 `open` 두 이벤트 | |
  | 손절·익절 변경 (stopLossPrice/takeProfitPrice 가 바뀜, 수량 그대로) | `tpsl` (slPrice/tpPrice 포함) | 팔로워 장부 포지션에 **같은 절대가**로 updateTpSl (팔로워 강제정리 안쪽이면 그 직전, 마크를 이미 지났으면 건너뜀·기록) |
  | 배율 변경 (leverage 가 바뀜, 수량 그대로) | `leverage` | 팔로워 `adapter.setLeverage` (팔로워 상한으로 자름) + 장부 갱신 |
  **2026-09-18 사용자 요구: 마스터가 진입 비율·배율·손절가를 바꾸면 무조건 실시간으로 팔로워에 같이 반영된다.** 비율은 이벤트마다 마스터 자산 대비로 다시 계산하고(open/add), 배율·손절·익절은 위 두 이벤트로 즉시 복제한다. 개인 WS 의 `futures/order` 는 플랜(손절·익절) 주문 변경에도 오므로 깨우기가 된다.
  이벤트 id = `copy-<masterId>-<symbol>-<seq>` (seq 는 마스터별 단조 증가, `copy_master_state.seq`). 같은 이벤트는 두 번 실행되지 않는다(`copy_executions` UNIQUE).
- 마스터 자산(`wallet.equity`)과 진입가·배율도 이벤트에 기록(비례 계산 근거).
- 워치독: 크론(매분) → `/kick` 으로 승인된 마스터 전원의 DO 알람을 되살린다(BottomWatcher 와 같은 패턴). 마스터가 `approved` 가 아니면 DO 는 스스로 멈춘다.
- 1 DO 당 WS 1개. 마스터 50명이면 DO 50개 — Workers 한도 안.

## 3. 팬아웃 실행 — `CopyTrader` DO (AutoTrader 와 같은 샤딩: 코디네이터 `global` + `shard-N`, 3명씩, 심볼별 직렬화)
- 입력: `copy_events` 한 건. 팔로워 = `copy_follows` 중 `active` + 자격 통과(`listActiveFollowers(masterId)`).
- 실행 결과는 `copy_executions` 에 사용자별 status/detail/order_id/contracts 기록. `copy_positions` 갱신(팔로워의 "따라 들어간 포지션" 장부).
- **비례 크기 (`server/src/copy/sizing.ts`, 순수 함수·테스트 필수)**
  - open/add: 마스터가 이번에 늘린 계약 Δ, 가격 P, 배율 L, 마스터 자산 E(이벤트 직전 equity). 마스터가 쓴 증거금 비율 r = (Δ × contractSize × P / L) / E.
    팔로워 증거금 m = r × copyAmount (copyAmount = 팔로우 시 정한 투자금, 실현손익 반영해 `copy_follows.copy_amount_now` 로 추적). 배율 Lf = min(L, 팔로워 maxLeverage, 거래소 max). 계약 수 = floor(m × Lf / (contractSize × P)). 0이면 `skipped: 금액이 너무 적음`. m 이 available 보다 크면 available 로 줄인다(기록).
  - reduce: 비율 f = 1 − after/before. 팔로워 정리 계약 = round(copy_positions.contracts × f), 최소 1, 남는 게 0이면 전량.
  - close: copy_positions 전량 정리(실제 계좌 포지션이 더 크면 **장부 수량만** 정리 — 사용자가 직접 넣은 포지션은 건드리지 않는다. 같으면 closePosition).
  - 손절·익절: **마스터와 완전히 동일.** 마스터의 현재 손절가·익절가(이벤트의 slPrice/tpPrice)를 그대로 쓰고, 마스터가 지우면 팔로워도 지운다(2026-09-18 사용자 결정 — 팔로워의 `slRoi` 로 더 빡빡하게 만들지 않는다). 마스터에 손절이 없을 때만 팔로워 설정 `slRoi`(기본 30) 로 `priceAtRoi` 진입(진입에 손절은 필수). 팔로워 강제정리 안쪽이면 강제정리 직전 값. `tpsl` 이벤트는 장부 포지션이 있는 팔로워에게 updateTpSl(null = 해제). 손실 한도가 마지막 방어선.
  - 손실 한도: `loss_limit_pct`(기본 50, 최대 95). 실현손익 누적 + 장부 미실현이 −copyAmount×pct% 를 넘으면 팔로우를 `stopped(loss_limit)` 로 바꾸고 장부 포지션 전량 정리. 체크 시점: 각 이벤트 실행 전 + 60초 알람.
- 실행 어댑터: paper 는 `PaperClient`, live 는 `WooxAdapter`. 부분 정리를 위해 **두 어댑터에 `reducePosition(symbol, contracts, contract)` 추가** (woox: 반대 side IOC 지정가 ±1%, 남은 수량이 0이면 플랜 주문 취소; paper: 엔진 partial close — `closePosition` 에 contracts 인자).
- 스테일 시세(>30s)·시세 없음이면 이벤트 전체 `failed` 기록 후 중단(자동매매와 동일).

## 4. 데이터 (D1 0015)
- `copy_masters(user_id PK, nickname UNIQUE, intro, status, applied_at, decided_at, decided_by, note, terms_version, created_at, paused, hide_json)` status: pending|approved|suspended|rejected. `hide_json`(D1 0021) = `CopyMasterHide` JSON `{ followers, trades, winRate, roi, recent }` (true = 다른 사용자에게 숨김, NULL = 전부 공개)
- `copy_follows(id, follower_id, master_id, status active|stopped, mode, copy_amount, copy_amount_now, loss_limit_pct, max_leverage, sl_roi, terms_version, agreed_at, started_at, stopped_at, stop_reason, realized_pnl)` — follower 당 active 1개 (부분 UNIQUE 인덱스)
- `copy_master_state(master_id, symbol, seq, direction, contracts, entry_price, leverage, equity, updated_at)` PK(master_id, symbol) + `copy_master_meta(master_id PK, seq, ws_ok, last_poll_at, last_error)`
- `copy_events(id PK, master_id, seq, symbol, kind, direction, before_contracts, after_contracts, price, leverage, master_equity, created_at, processed_at, follower_count, ok_count, fail_count, skipped_count)`
- `copy_executions(event_id, follower_id, mode, status ok|failed|skipped, detail, order_id, contracts, created_at)` UNIQUE(event_id, follower_id)
- `copy_positions(follower_id, master_id, symbol, direction, contracts, entry_price, leverage, opened_at, updated_at)` PK(follower_id, symbol)
- `copy_master_stats(master_id PK, days30_pnl, days30_roi, win_rate, trades, followers, aum, updated_at)` 5분 캐시

## 5. API (`server/src/routes/copy.ts`) — 전부 세션 필요, 관리자는 `isAdmin`
사용자
- `GET /api/copy` → `CopyStateResponse { me: { master: CopyMasterMe|null, follow: CopyFollowMe|null, copyTermsOutdated }, masters: CopyMasterCard[] }`
- `POST /api/copy/master/apply { nickname, intro, agree:true, masterTermsVersion }` (실거래+키+KYC 확인) → 202 pending
- `PUT /api/copy/master { intro }` 소개 수정
- `PUT /api/copy/master/hide { hide: Partial<CopyMasterHide> }` 공개 숨김(2026-09-18): 팔로워 수·거래 횟수·승률·30일 수익률·최근 마감 거래를 항목별로 다른 사용자에게 숨김. true/false 만(400 `BAD_HIDE`), 고수 행이 없으면 404 `NOT_MASTER` → `{ ok, hide }`. `CopyMasterMe.hide` 로 현재값. **숨긴 항목은 공개 카드(`GET /api/copy` 의 masters)·프로필에서 키 자체가 빠지고**(`followers?/trades?/winRate?/days30Roi?/recent?`), `hide` 로 무엇이 비공개인지만 알린다. 고수 본인(목록의 내 카드·내 프로필·대시보드 `stats`)과 관리자 카드(팔로워 수)는 계속 전부 본다. `hide.recent` 면 프로필에서 거래소 조회도 하지 않는다.
- `GET /api/copy/masters/:id` → `CopyMasterProfile` (카드 + 최근 30일 거래 요약 + 현재 포지션 방향/종목만, 수량·금액 비공개. 고수가 숨긴 항목은 없음)
- `POST /api/copy/follow { masterId, copyAmount, lossLimitPct, maxLeverage, slRoi, agree:true, copyTermsVersion }` → 409 if AI 자동매매 켜짐 / 이미 팔로우 중 / 자기 자신 / 마스터 미승인
- `PUT /api/copy/follow { copyAmount?, lossLimitPct?, maxLeverage?, slRoi? }`
- `POST /api/copy/unfollow { closePositions: boolean }` → `stopped(user)`; closePositions 면 장부 포지션 전량 정리
- `GET /api/copy/executions` 내 실행 내역 50건 (+ 실현손익)
마스터 대시보드
- `GET /api/copy/master/dashboard` → `{ followers: CopyFollowerRow[] (아이디 마스킹 `ab***12`, mode, copyAmount, positions[] from copy_positions + mark → 미실현, realizedPnl, startedAt), events: 최근 30건 + 집계, stats }` — **거래소 호출 없음**(장부 + 시세). 화면은 3초 폴링.
- `GET /api/copy/master/events/:id/executions` 이벤트별 사용자 결과
관리자 (`/api/admin/copy`)
- `GET /` pending/approved/suspended/rejected 마스터 + 최근 이벤트
- `POST /masters/:userId { action: approve|reject|suspend, note }`
- `GET /follows` 전체 팔로우 목록 + `POST /follows/:id/stop`
- `POST /masters/:userId/kick` 감시 DO 즉시 깨우기, `GET /masters/:userId/status` DO 상태

## 6. 화면 (`web/`)
- 홈 스위치 3개. `CopyView`: (a) 내가 팔로우 중이면 "따라가는 중" 카드(마스터 닉네임, 투자금·현재 손익, 손실 한도 게이지, 장부 포지션 목록, 멈추기(길게 누르기, 정리 여부 선택)), (b) 마스터 목록 카드(닉네임·30일 수익률·승률·팔로워 수·거래 수, 큰 버튼), (c) 프로필 시트 → 따라하기 폼(투자금 슬라이더+입력, 손실 한도 10~95%, 최대 배율 1~50, 손절 % 10~95, 카피 특약 끝까지 읽어야 동의 — AutoTermsBox 재사용), (d) 마스터 신청 카드/시트, (e) 마스터면 "내 팔로워" 대시보드(3초 갱신, 팔로워별 포지션·손익·투자금, 이벤트별 성공/실패/건너뜀) + "공개 설정" 카드(팔로워 수/거래 횟수/승률/30일 수익률/최근 마감 거래 5줄, 각각 56px 토글 버튼 "👁 공개 중"/"🙈 숨김" — 글자로 상태 표시, 누르면 바로 저장 + 토스트). 다른 사용자의 목록 카드·프로필 시트는 숨긴 항목 자리에 "비공개"(예: "팔로워 비공개", 30일 수익률·승률 타일 "비공개 / 고수가 숨겼어요", 최근 거래 "고수가 최근 거래를 비공개로 설정했어요")를 보여 준다. 기록 로드 실패 시 "기록을 불러오지 못했어요 + 다시 시도"(2026-09-18 감사 C3).
- 실행 내역은 거래 내역 시트에 출처 `copy` 배지 추가(TradeHistoryItem.source 에 'copy').
- 용어: 마스터 트레이더 → "고수", 팔로우 → "따라하기", copy amount → "따라갈 돈", loss limit → "여기까지 잃으면 멈추기".
- 관리자 시트: 마스터 신청 승인/거절/중지, 팔로우 목록, 감시 상태.

## 7. 약관 (`web/src/content/copy-terms.ts`, `shared` 버전 상수)
- `COPY_TERMS_VERSION`(팔로워 특약): 투자 판단·손실 책임은 팔로워, 회사·마스터는 수익 보장 없음, 지연·미체결·부분체결·거래소 장애 가능, 손실 한도는 시장가 정리라 그 이상 손실 가능, 마스터 중지 시 포지션 유지, 언제든 해지, 분쟁은 관할 합의 등 — AI 자동매매 특약(`auto-terms.ts`)과 같은 강도.
- `MASTER_TERMS_VERSION`(마스터 약관): 자기 매매가 팔로워에게 복제됨을 인지, 조작·펌핑·허위 소개 금지, 회사가 언제든 중지 가능, 팔로워 정보는 마스킹된 범위만 열람, 개인정보 보호 의무.
- 버전이 올라가면 팔로우/마스터 활동 정지 + 재동의 안내(`copyTermsOutdated`).

## 8. 안전 규칙 (CLAUDE.md 와 동일 수준)
- 팔로워 진입은 반드시 손절가와 함께. 강제정리 안쪽 손절이면 건너뜀.
- 이벤트 중복 실행 금지(UNIQUE), 마스터 DO 는 심볼별 seq 로 순서 보장, 팬아웃은 심볼별 직렬화.
- 팔로워가 직접 잡은 포지션은 건드리지 않는다(장부 수량만 정리). 반대 방향 포지션이 있으면 skipped.
- 마스터 계좌 키는 감시(읽기)에만 쓴다. 마스터 계좌로 주문을 내지 않는다.
- 실계좌 검증은 관리자 1계약으로만. 전 흐름 테스트는 vitest 와 관리자 연습 계정(`ALLOW_PAPER=on`)의 연습 마스터 + 연습 팔로워로만 돈다 — 일반 사용자에게 연습 모드는 없다(2026-09-18).
- (2026-09-18 감사 반영, 관리자 연습 계정에만 해당) 팔로우는 시작한 모드(paper/live)에 묶인다: 모드가 바뀌면 `stopped(mode_switch)`, 실행기도 `settings.mode ≠ follow.mode` 면 건너뛴다. 승인된 고수가 연습으로 바꾸면 `suspended` + 팔로우 전부 정지. 감시 DO 는 실거래가 아닌 고수(관리자 제외)를 감시하지 않는다.
- 고수끼리 서로(또는 돌아서) 따라갈 수 없다(409 `COPY_CYCLE`). 고수가 다른 고수를 따라가는 중이면 감시 DO 는 디프를 내지 않는다(`last_error` 기록).
- 같은 종목에 **장부로 설명되지 않는 같은 방향 포지션(직접 잡은 것)** 이 있으면 open/add 를 건너뛴다(손절이 섞이지 않게). 반대 방향과 같은 취급.
- 팔로워 `slRoi` 는 항상 손절의 상한: 손절 = tighter(고수 손절, 내 돈 기준 slRoi) → 강제정리 안쪽 보정. 진입·tpsl·배율 변경 뒤 모두 적용.
- 주문 전에 `copy_executions` 에 `pending` 행을 선점하고(UNIQUE) 결과를 나중에 UPDATE. 2분 넘게 pending 이면 결과 불명 실패로 닫고 다시 주문하지 않는다. 유실 복구로 늦게 도는 open/add/tpsl/leverage 는 더 최신 이벤트가 있으면 건너뛴다(정리만 재생).
- 실제 포지션이 없는 장부(손절·익절·강제정리로 끝남)는 실행·60초 점검마다 거래 내역(하루)의 정리 체결 손익−수수료로 정산해 실현손익에 더한다(내역이 없으면 손절가/익절가/마크 추정 + 수수료 0.05%×2). 손실 한도는 30초 안에 갱신된 시세로만 판정하고, 오래된 시세로는 시장가 정리를 하지 않는다.
- 정리 없이 팔로우가 멈추는 모든 경로(해지 미정리·고수 중지·관리자·키 삭제·모드 전환·신분증 거절)에서 장부(`copy_positions`)를 지운다 — 남은 포지션은 그때부터 사용자 본인 것. 총 노출은 `available = min(계좌 available, copyAmountNow − Σ장부 증거금)` 로 제한.
- 실거래 고수의 줄어듦(close/reduce)은 두 번 연속 폴링에서 확인돼야 이벤트가 된다(거래소가 한순간 빈 목록을 줘도 팔로워 전량 정리 금지). 열린 종목이 한 번에 전부 사라졌는데 포지션 증거금이 남아 있으면 그 폴링은 버린다.
- add 의 비례 계산은 이벤트의 배율(고수 포지션의 합산 배율)을 쓴다 — 델타 배율은 알 수 없어 허용 오차로 둔다. 불타기는 기존 포지션 배율을 그대로 쓴다(거래소가 열린 포지션의 배율 변경을 막을 수 있음).
- 공개 카드·프로필에는 30일 손익 **금액** 을 싣지 않는다(수익률·승률·거래 수만). 통계는 `copy_master_stats.updated_at` 5분 게이트로 갱신하며 감시 DO 알람도 5분마다 갱신한다(프로필을 열지 않아도 목록이 채워짐).

## 9. 파일 소유(병렬 작업)
| 파일 | 담당 |
|---|---|
| `shared/src/index.ts`(타입·버전), `server/migrations/0015_copy_trading.sql`, `server/src/copy/db.ts`, `server/src/copy/sizing.ts`(+test), `server/src/env.ts`, `server/wrangler.toml`, `server/src/index.ts` 등록 | 기반(완료 후 배분) |
| `server/src/copy/MasterWatcher.ts`, `server/src/copy/CopyTrader.ts`, `server/src/copy/*.test.ts`, `server/src/adapters/{woox,paper}.ts` `reducePosition`, `server/src/paper/*` partial close, `server/src/scheduled` kick | 서버 A |
| `server/src/routes/copy.ts`(+test), `server/src/routes/{keys,kyc,trade,auth}.ts` 의 팔로우 정지 훅, `server/src/history.ts` source 'copy' | 서버 B |
| `web/src/components/Copy*.tsx`, `web/src/content/copy-terms.ts`, `web/src/lib/api.ts` 추가, `web/src/App.tsx` 탭, AdminSheet 카피 절, HistorySheet 배지 | 웹 |


### 배율 변경 실측 (2026-09-21)
- 고수가 거래소에서 배율을 바꾸면 `leverage` 이벤트로 팔로워 전원에게 `submit-leverage` 를 보낸다. 거래소는 **손절·익절 예약 주문이 걸린 포지션의 배율 변경을 40012 로 거절**한다(예약 없으면 즉시 성공, 대표 계정 실측). 어댑터 `setLeverage` 는 40012 를 받으면 예약을 취소 → 배율 변경 → 같은 값으로 즉시 재등록(finally) 한다. 이어서 `mirrorLeverage` 가 새 강제정리 기준으로 손절을 다시 적용한다.
- 추가 진입(add)은 거래소 규칙상 **실제 포지션의 배율**로만 가능하므로, 배율 변경이 거절된 팔로워는 기존 배율로 추가 진입된다. 장부 배율은 15초 점검에서 실제 포지션 값으로 동기화된다.
- 관리자 진단: `GET /api/admin/copy/debug/positions/:userId`(읽기 전용, 마진 모드·배율·수량 원문), `POST /api/admin/copy/debug/leverage`(관리자 본인 계좌만).

### 부분 정리 이월·체결 확인·포지션 모드 (2026-09-22)
**부분 정리 이월 (`sizing.reduceContracts`, D1 0023 `copy_positions.reduce_carry`)**
- 예전 규칙 `max(1, round(장부 × 비율))` 은 장부 1~2계약 팔로워를 고수의 5% 축소에 전량(또는 과다) 정리했다. 이제 정확한 비례 수량 `장부 × (1 − after/before) + 이월` 을 **내림**해 정수 계약만 정리하고, 1계약 미만 나머지는 `reduce_carry` 에 이월한다. 0계약이면 실행 결과 `skipped: 고수가 줄인 비율이 1계약 미만 — 다음 축소에 합산 (이월 0.4계약)`.
- 고수 → 0(close)은 이월과 무관하게 전량. 전량 정리는 행이 지워지므로 이월도 사라지고, 신규·추가 진입(open/add)은 이월을 0 으로 되돌린다(비율의 기준 장부가 바뀜). 정리 실패·일부 체결이면 예전 이월을 유지한다.
- 예: 장부 1계약, 고수 40% 씩 세 번 → 0.4 → 0.8 → 1.2 → 세 번째에 1계약 정리. 테스트 `server/src/copy/reduce-carry.test.ts`.

**체결 확인 (`adapters/woox.ts` openOrder·closeContracts)**
- 예전: 주문 뒤 `position-v2` 를 200ms 마다 최대 10번(정리는 5번) 폴링 + 손절 정렬에서 최대 10번 더 → 팬아웃(팔로워 9명)에서 429, 3명이 `ORDER_SENT_UNCONFIRMED`(2026-09-22 관측).
- 지금: 주문 뒤 **주문 1건 조회 `GET /contract/private/order?symbol&order_id`** 를 250ms·500ms·1s·2s 뒤 최대 4번 — `deal_size > 0`(체결) 또는 `state == 4`(종료)가 보이면 멈춘다. 그 뒤 **포지션은 한 번만** 읽어 늘어난 수량·평단(손절 정렬에도 그 행을 재사용)을 만든다. 조회 429 는 `Retry-After` 뒤 한 번 재시도, 다른 오류·미등록이면 포지션 폴링 3번으로 폴백(예전 판정). 포지션 반영이 늦어 수량이 안 늘었어도 주문 조회의 `deal_size` 로 체결을 확정한다(정리는 다음 시도의 기준 수량을 `lastLeft` 로 낮춰 같은 물량을 두 번 내지 않는다). `NO_FILL`·`PARTIAL_CLOSE`·`ORDER_SENT_UNCONFIRMED` 의미는 그대로. 팔로워 1명당 확인 호출 수: 최대 21회 → 보통 2~3회.
- 주문 조회 응답 필드 가정(BitMart V2, `client.ts` `toFill`): `state`(1 approval·2 check·4 finish), `deal_size`, `deal_avg_price`. **TODO(verify-live)**: 실계정 1계약으로 필드명 확인 — 확인 전까지는 `deal_size` 가 비어 오면 "체결 0" 으로 읽혀 포지션 폴백이 판정을 맡는다(폴백이 있어 진입을 놓치지는 않는다).

**포지션 모드 실측 (헤지/단방향)**
- 엔드포인트: `GET /contract/private/get-position-mode` → `{ position_mode: "hedge_mode" | "one_way_mode" }`, `POST /contract/private/set-position-mode`(`client.getPositionMode()/setPositionMode()`, docs/woox-pro-api.md). 앱의 side 코드(1/4 진입, 3/2 정리)는 **단방향(one_way_mode) 가정**이다 — 헤지 모드면 3/2 가 "롱 정리/숏 정리" 가 아니라 반대 포지션 진입이 될 수 있다.
- 실측 상태: **라이브 계정으로 직접 호출해 보지 못했다(2026-09-22, 코드 작업만).** 관리자·고수 계정의 `position-v2` 가 종목마다 롱·숏 두 행을 돌려주는 것은 관측됐으나(수량 0 행은 어댑터가 걸러낸다), 이것이 헤지 모드의 증거인지 단방향에서도 두 행을 주는지는 `get-position-mode` 응답으로 확인해야 한다. 지금까지 실주문(진입·정리·손절)이 단방향 매핑으로 정상 동작했으므로 **단방향으로 추정**한다.
- 키 등록(`PUT /api/keys`): 키 검증 뒤 `get-position-mode` 를 호출해 `hedge_mode` 면 400 `HEDGE_MODE`("거래소 계정이 양방향(헤지) 모드예요. WOO X Pro 설정에서 단방향 모드로 바꾼 뒤 다시 등록해 주세요"). 엔드포인트가 없거나 오류면 **경고만 남기고 등록을 허용**한다(확인 안 된 API 로 등록을 막지 않는다). 응답값은 `api key position mode` 로그로 남으므로 첫 실등록 로그가 곧 실측이다.
- `getAccount` 결과에 `positionMode: 'hedge' | 'one_way' | 'unknown'` 추가(실거래만, `position-v2` 행의 `position_mode` 로 추정 — 추가 호출 없음, 포지션이 없으면 unknown). 표시·진단용이며 거래 동작은 바꾸지 않는다.

## 10. 운영 안전 보강 (2026-09-22) — D1 0024
### 정리하지 못한 포지션 (`copy_leftovers`)
- 팔로우가 **정리 없이 멈추는 모든 경로**(해지 미정리 `user`, 관리자 `admin`, 키 삭제 `no_api_key`, 모드 전환 `mode_switch`, 신분증 거절 `kyc_rejected`, 고수 중지 `master_suspended`)에서 장부(`copy_positions`, 수량 > 0)를 `copy_leftovers` 에 스냅샷한 뒤 지운다(`db.ts` `snapshotLeftovers` — `stopFollowsOfUser`/`stopFollowsOfMaster` 안에서, 해지·관리자 정지는 라우트에서). 해지 시 `closePositions:true` 면 실행 DO 가 정리하고 **실패한 종목만** 남는다.
- 손실 한도 정리가 일부 실패하면(`CopyTrader.noteLossLimitPartial`) 실패한 종목만 `loss_limit_partial` 로 남긴다. 같은 팔로우·종목의 미확인 행은 15초 재시도마다 늘지 않고 수량만 갱신(`insertLeftovers` 의 UPDATE-then-INSERT). 팔로우는 계속 재시도한다.
- 사용자: `GET /api/copy` 의 `follow.leftovers`(최근 팔로우, 미확인분) → 화면에 "정리하지 못한 포지션 — 직접 정리하세요" → `POST /api/copy/leftovers/ack` 로 지운다. 관리자 목록 `AdminCopyFollow.leftovers` 는 미확인 수.
### 관리자 텔레그램 알림 (`server/src/copy/notify.ts`)
- `notifyAdmin(env, text, { key })` — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ADMIN_CHAT_ID` 없으면 무동작, 같은 key 는 10분에 한 번(`copy_flags` 의 `notify:<key>` 행), 절대 던지지 않는다. 문장은 `[카피]` 접두 + 600자 상한, 아이디는 `ab***2` 마스킹. 호출은 `ctx.waitUntil` 로 붙여 신호를 늦추지 않는다.
- 트리거: 손실 한도 도달(`loss:<followId>`), 손실 한도 정리 일부 실패(`loss-partial:`), 놓친 정리 보정(`swept:`), 실패가 있는 이벤트 팬아웃(`event-fail:<eventId>`, 팔로워별 사유), 주문 접수 후 확인 실패 pending(`unconfirmed:`), pending/실패 행의 거래소 복구(`recovered:`), 고수 감시 폴링 5회 연속 실패(`poll-fail:<masterId>`), 고수 강제정리·ADL(`liq:<masterId>:<symbol>`), 정리하지 못한 포지션 남김(`leftover:<followId>`).
- 테스트는 `src/test/setup.ts` 가 `notifyDeps.send` 를 스텁한다(바깥 fetch 가 테스트 경계를 넘기지 않게). 문구·중복 제거는 `copy/notify.test.ts`.
### 한 지갑 공유 가드 (`routes/trade.ts`)
- 따라하기가 켜져 있고 그 고수를 따라 들어간 장부가 같은 종목에 있으면 직접 주문 `POST /api/order/open`·`/position/close`·`/position/tpsl` 을 **409 `COPY_SYMBOL_LOCKED`** 로 막는다. 웹이 확인 창을 거쳐 `force:true` 로 다시 보내면 통과. `AppState.positions[i].copy = { masterNickname }` 로 따라 들어간 포지션에 배지(장부 조회 1회, 3초 캐시 `copyBadgesOf`).
### 슬리피지
- `copy_executions.fill_price` = 팔로워 체결 평균가(open/add: 어댑터 `fillPrice`, 첫 진입은 평단; close/reduce: 어댑터가 `avgPrice` 를 주면). `slippagePct = ±(체결가 − 이벤트 가격)/이벤트 가격 × 100`, **팔로워에게 불리하면 양수**(`db.ts` `slippagePctOf`). `CopyExecution.fillPrice/slippagePct`, 대시보드 `lastExecution.slippagePct`, `CopyFollowMe.avgSlippagePct`(30일 평균).
### 고수 강제정리·ADL 표시
- 감시 DO 가 close 이벤트를 만들고 팬아웃을 던진 **뒤** 실거래 고수의 최근 2분 주문 이력(`getOrderHistory`, 3초 상한)에서 `liquidate`/`bankruptcy` → `liquidation`, `adl` → `adl`, 아니면 `normal` 로 `copy_events.close_reason` 을 채운다(`classifyCloseOrders`, 조회 실패면 NULL). 연습 고수는 바로 `normal`. `CopyEvent.closeReason`, 팔로워 실행 내역 detail 앞에 "고수 강제정리로 정리 · " 표기. 강제정리·ADL 이면 관리자 알림.
