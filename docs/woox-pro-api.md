# WOO X Pro API 정리 (2026-09-07 조사)

문서: https://developer.wooxpro.com (인덱스: /llms.txt). BitMart Futures V2 API와 구조·필드가 동일한 화이트라벨.
테스트넷/샌드박스: **없음**. → 앱에 연습 모드(Paper) 내장 필수, 실거래 검증은 1계약으로.

## 기본
- REST: `https://cloud-api.wooxpro.com`
- WS 공개: `wss://cloud-ws.wooxpro.com/api?protocol=1.1`
- WS 프라이빗: `wss://cloud-ws.wooxpro.com/user?protocol=1.1`
- 응답: `{ code: 1000, message: "Ok", data, trace }` (1000이 성공)
- GET/DELETE: 쿼리스트링, POST/PUT: JSON body
- 심볼: `BTCUSDT`, `ETHUSDT`. `contract_size`(BTC 0.001), `price_precision`, `vol_precision`, `min_volume`, `max_leverage` → `/contract/public/details`
- **size는 계약 수(정수)**. 코인 수량 = size × contract_size

## 인증 (KEYED = 키만, SIGNED = 서명)
헤더: `X-API-KEY`, `X-API-SIGN`, `X-API-TIMESTAMP`(ms). KEYED 엔드포인트도 실무상 세 헤더 모두 보내면 안전.
```
sign = hex( HMAC_SHA256( secret, `${timestamp}#${memo}#${body}` ) )
```
- memo = API 키 만들 때 적은 Memo 문자열(키의 일부로 취급)
- body: POST는 JSON 문자열 그대로(전송 바이트와 동일해야 함), GET은 `symbol=BTCUSDT&x=y` 형태 쿼리(없으면 빈 문자열)
- 문서 예시 벡터(단위테스트용):
  - 입력 `1589793796145#test001#{"currency":"USDT","amount":"10","transferType":"spot_to_contract"}`
  - secret `6c6c98544461bbe71db2bca4c6d7fd0021e0ba9efc215f9c6ad41852df9d9df9`
- WS 로그인: `{"action":"access","args":[apiKey, timestamp, sign, "web"]}`, sign 문자열 = `${timestamp}#${memo}#wooxpro.WebSocket`

## CORS 실측 (curl, Origin 헤더)
- 공개 GET: `access-control-allow-origin: *` → 브라우저 직결 가능 (시세·K선·상세)
- 프라이빗: preflight 200이지만 `allow-headers`에 X-API-* 없음 → **브라우저 차단**. 서버 프록시 필수.
- 레이트리밋 헤더: `x-bm-ratelimit-limit/remaining/reset/mode`

## 레이트리밋
공개: IP당 대개 12회/2초. 프라이빗: 키당 주문 24회/2초, 취소 40회/2초, 조회 6~50회/2초, 이체 1회/2초. 초과 시 429.

## 사용할 엔드포인트
| 목적 | 메서드/경로 | 비고 |
|---|---|---|
| 계약 상세 | GET `/contract/public/details?symbol=` | contract_size, precision, min_volume, max_leverage |
| K선 | GET `/contract/public/kline?symbol&step&start_time&end_time` | step 분 단위(1,3,5,15,30,60,…,1440), 초 단위 timestamp, 최대 500개 |
| 자산 | GET `/contract/private/assets-detail` (KEYED) | currency, available_balance, equity, unrealized, position_deposit |
| 포지션 | GET `/contract/private/position-v2?symbol` (KEYED) | entry_price, open_avg_price, mark_price, position_amount, leverage, open_type, position_side(long/short/both), liquidation_price, unrealized_pnl, initial_margin |
| 포지션 모드 | GET `/contract/private/get-position-mode`, POST `set-position-mode` | `one_way_mode` 권장(어르신 UX 단순화) |
| 레버리지 | POST `/contract/private/submit-leverage` {symbol, leverage, open_type} | 응답 max_value |
| 주문 | POST `/contract/private/submit-order` | 아래 참고 |
| TP/SL | POST `/contract/private/submit-tp-sl-order` | type take_profit/stop_loss, trigger_price, price_type 1=last 2=fair, category market, plan_category 2=포지션 TP/SL, size |
| TP/SL 수정 | POST `/contract/private/modify-tp-sl-order` | |
| 미체결 | GET `/contract/private/get-open-orders`(문서 open-order.md) | |
| 취소 | POST `/contract/private/cancel-order`, `cancel-orders` | |

### submit-order 파라미터
- `symbol`, `side`(Int), `type` limit|market, `price`(limit만), `size`(Int 계약수), `leverage`(String), `open_type` cross|isolated, `mode` 1=GTC 2=FOK 3=IOC 4=MakerOnly
- `preset_take_profit_price`, `preset_stop_loss_price` (+ `_type` 1=last 2=fair) → **진입과 동시에 손절 설정 가능**
- `client_order_id` ≤32자 영숫자

### side 코드 (BitMart V2와 동일 — 실주문 1계약으로 검증 필요)
| 값 | hedge_mode | one_way_mode |
|---|---|---|
| 1 | buy_open_long | buy |
| 2 | buy_close_short | buy (reduce only) |
| 3 | sell_close_long | sell (reduce only) |
| 4 | sell_open_short | sell |

one_way_mode 기준 매핑: 오른다에 걸기=1, 내린다에 걸기=4, 롱 정리=3, 숏 정리=2.

## WebSocket
- 구독: `{"action":"subscribe","args":["futures/ticker:BTCUSDT"]}` / K선 `futures/klineBin1m:BTCUSDT`
- 프라이빗 채널: `futures/position`, `futures/order`, `futures/asset`(assets.md 확인)
- ticker 필드: last_price, mark_price, index_price, ask/bid price·vol, volume_24, range
- position 푸시: hold_volume, hold_avg_price, open_avg_price, liquidate_price, position_type, open_type, position_mode
- keepalive: 메시지 없으면 20초 후 끊김. N<20초 타이머로 `{"action":"ping"}` 전송, `pong` 기대. 접속 후 5초 내 구독 안 하면 끊김.

## 미확인/주의
- 서명 문자열의 GET 쿼리 파라미터 정렬 규칙(BitMart는 요청 그대로) — 서버에서 동일 문자열을 전송·서명에 사용.
- KEYED 엔드포인트가 SIGN 없이 통과하는지 미확인 → 항상 서명.
- 자산 채널 문서 파일명 `websocket/assets.md` 확인 필요.

## ⚠️ 유동성 실측 (2026-09-07 18:50 KST) — 반드시 읽을 것
`cloud-api.wooxpro.com` 공개 데이터 기준:
- `details` BTCUSDT: `last_price: "644"`, `index_price: 79,377`, `low_24h: 644`, `high_24h: 200000`, `change_24h: -0.99`
- `market-trade` BTCUSDT: 최근 체결이 644달러에 12.1 BTC, 34.5 BTC 등. 그 이전 정상 체결(78,261.8)은 며칠 전.
- `kline` step=15 최근 24시간: **0개**. step=60 최근 7일: **2개**(둘 다 644).
- `depth` BTCUSDT: `data: null` (호가 없음)
- ETHUSDT도 동일 양상: last 1,150 / index 2,487.
- 반면 WS `futures/ticker` 의 `last_price`는 79,280으로 정상(지수/마크에 가까움).

해석: WOO X Pro 자체 선물 호가창은 사실상 **비어 있거나 극도로 얇다**. 시장가 주문은 지수와 동떨어진 가격에 체결될 위험이 매우 크다.
설계 반영(필수):
1. 진입은 시장가 대신 **지정가 IOC** (`type:'limit'`, `mode:3`, 가격 = 마크가 × (1 ± 슬리피지 상한 0.3%)) 로 체결 범위를 강제한다. 미체결분은 자동 취소되며 사용자에게 "지금은 체결이 어려워요"로 안내.
2. 손절/익절/프리셋 TP·SL의 `price_type`은 반드시 **2 = fair_price(마크가)**. `last_price`(1)는 644 같은 이상 체결에 반응한다.
3. 화면의 "지금 가격"은 `mark_price`/`index_price`를 기준으로 표시하고, `last_price`는 쓰지 않는다.
4. 실계정 연결 전에 반드시 **1계약 실주문 테스트**로 실제 체결가·마크가 산출 방식을 확인한다. 유동성이 이 상태면 거래소 변경을 검토해야 한다.

실측 계약 정보: BTCUSDT contract_size 0.001, price_precision 0.1, vol_precision 1, min_volume 1, max_leverage 200 / ETHUSDT contract_size **0.001**, price_precision 0.01, max_leverage 200. 심볼 55개.

### 정정 및 결정 (2026-09-07 19:20 KST) — WebSocket 실측
공개 WS(`wss://cloud-ws.wooxpro.com/api`)를 12초간 구독한 결과 **시장은 살아 있다**:
- `futures/ticker:BTCUSDT`: last 79,374.7 / mark 79,374.7 / index 79,405.7, **ask 79,374.7 × 17,889계약, bid 79,374.6 × 18,145계약** (스프레드 0.1달러, 호가 잔량 각 약 18 BTC)
- `futures/trade:BTCUSDT`: 12초에 체결 13건(79,374.7), `futures/depth5/20`: 12초에 갱신 23회
- ETHUSDT도 동일하게 정상(ask 2,488.19 × 83,223계약)

결론: 유동성 자체는 충분하다(BitMart 공유 유동성으로 보임). **깨진 것은 `cloud-api.wooxpro.com`의 공개 REST 일부**(`details.last_price`, `market-trade`, `kline`, `depth`)이며, WS와 `markprice-kline`, `details.index_price`는 정상.

**결정: WOO X Pro 유지.** 조건:
1. 가격·차트·트리거 판단은 **WS 티커/`kline-mark-price`**만 사용. 공개 REST `kline`·`depth`·`market-trade`·`last_price`는 코드에서 쓰지 않는다.
2. 지정가 IOC(마크가 ±0.3%) 진입과 fair_price 트리거는 그대로 유지(값싼 보험).
3. 실계정 1계약 테스트로 프라이빗 엔드포인트 매핑(side, 포지션 방향, 플랜주문 취소)을 확인한 뒤 사용자 개방.


## 요청 한도 실측 (2026-09-28, 대표 키)
| 엔드포인트 | 한도 | 창 | 단위 |
|---|---|---|---|
| /contract/private/position-v2 | 6 | 2초 | KEY |
| /contract/private/assets-detail | 12 | 2초 | KEY |
| /contract/private/order-history | 6 | 2초 | KEY |
| /contract/private/current-plan-order | 50 | 2초 | KEY |
헤더 `x-bm-ratelimit-limit/remaining/reset/mode`. **`remaining` 은 이 창에서 이미 쓴 횟수**(1회 호출 뒤 1). `WooxClient` 가 경로별 마지막 헤더를 기억해 한도−⅓ 에 닿으면 창이 끝날 때까지 기다린다(`throttle`). 관리자 진단: `GET /api/admin/copy/debug/ratelimit`.
