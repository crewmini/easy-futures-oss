# 자동매매 (신호 따라가기) — 봇 연동 가이드

## 구조
```
[저점 카운팅 봇 (파이썬, VPS)] --HMAC 서명 POST--> https://easyfutures.app/api/signals
                                                   └─ AutoTrader DO: 자동매매 승인+켬 사용자 전원에게 순차 실행(동시 8명)
                                                        ├─ 실거래 사용자: 본인 API 키로 지정가 IOC + 손절/익절
                                                        └─ (관리자 테스트 계정만) 연습 엔진에 가상 체결 — 일반 사용자는 실거래만(2026-09-18 연습 모드 제거)
```
- 자격: 신분증 승인 + API 키(실거래) + 약관 동의 + **자동매매 신청 → 관리자 승인(결제 확인)**. 승인 후 사용자가 직접 "켜기".
- 물량: 사용자 설정 "신호당 내 돈의 N%"(기본 10%), 배율은 `min(신호 배율, 사용자 최대, 설정 최대, 거래소 최대)`.
- 손절 필수: 신호에 `slRoi` 가 없으면 사용자 기본 손절(내 돈 기준 -20%) 적용. 익절은 선택.
- 반대 방향 포지션이 있으면 건너뜀. 정리(close) 신호는 해당 종목 전량 정리.
- 비상 버튼: 자동매매 끄기 + 현재 모드의 모든 포지션 정리.

## 신호 형식 (JSON)
| 필드 | 필수 | 설명 |
|---|---|---|
| id | ✓ | 봇이 만든 고유 id (영숫자·`-_:.` 4~80자). 같은 id 는 한 번만 실행 |
| symbol | ✓ | `BTCUSDT` 또는 `ETHUSDT` |
| action | ✓ | `open`(진입) / `add`(불타기·추가 진입, 같은 방향이면 물량 합산·평단 재계산) / `update`(손절·익절 갱신) / `close`(전량 정리) |
| direction | open/add 시 ✓ | `long`(오른다) / `short`(내린다) |
| leverage | | 권장 배율(1~100). 사용자 상한과 비교해 낮은 값 적용 |
| slPrice | | **절대 손절가** (예: 직전 저점). 지금 가격을 이미 지나쳤으면 % 손절로 대체 |
| tpPrice | | 절대 익절가 |
| slRoi | | 손절, 내 돈 기준 %(1~95). slPrice 가 없을 때 사용. 둘 다 없으면 사용자 기본값 |
| tpRoi | | 익절, 내 돈 기준 %(1~1000) |
| breakeven | | `true` 면 본절: 이익 중이면 손절=평단, 손실 중이면 익절=평단 (본전 오면 나가기). update 에서 사용 |
| note | | 화면에 보일 한 줄 설명 (예: "2번 저점 불타기") |

## 저점 카운팅 전략의 신호 시퀀스 (예)
```
1번 저점 확정  → open  long, slPrice = 1번 저점 아래
2번 저점 확정  → add   long, slPrice = 2번 저점 아래   (평단·물량 합산, 손절 상향)
3번 저점 확정  → add   long, slPrice = 3번 저점 아래
상승 확인      → update tpRoi 30 (또는 tpPrice)        → 익절 대기
2번 저점 깨짐  → close                                  → 지금 가격에 전량 정리 (2026-09-15 결정: 본절 대신 시장가 정리)
1번 저점 깨짐  → close                                  → 전량 정리
새 사이클 리셋 → update breakeven=true                  → 본전에서 나가기 (3 완성 체인이 유지 중일 때만)
```
각 신호의 id 는 `btc-15m-<봉시각>-<단계>` 처럼 유일하게. 같은 id 는 두 번 실행되지 않는다.

## 인증
- 헤더 `X-Timestamp`: 밀리초(또는 초) 유닉스 시각, 5분 이내
- 헤더 `X-Signature`: `HMAC_SHA256(secret, "<timestamp>.<body>")` 의 hex
- secret 은 서버 `AUTO_SIGNAL_SECRET` (wrangler secret). 봇 쪽에도 같은 값을 환경변수로.
- 응답: `202 {ok:true,id}` / 중복 `200 {duplicate:true}` / 401 서명·시각 오류 / 400 형식 오류

## 파이썬 전송 예제 (봇에 넣을 30줄)
```python
import hmac, hashlib, json, os, time, requests

EF_URL = "https://easyfutures.app/api/signals"
EF_SECRET = os.environ["EF_SIGNAL_SECRET"]

def send_signal(signal_id: str, symbol: str, action: str, direction: str | None = None,
                leverage: int | None = None, sl_price: float | None = None, tp_price: float | None = None,
                sl_roi: float | None = None, tp_roi: float | None = None, breakeven: bool = False, note: str = ""):
    body = {"id": signal_id, "symbol": symbol, "action": action, "note": note}
    if direction: body["direction"] = direction
    if leverage: body["leverage"] = leverage
    if sl_price: body["slPrice"] = sl_price
    if tp_price: body["tpPrice"] = tp_price
    if sl_roi: body["slRoi"] = sl_roi
    if tp_roi: body["tpRoi"] = tp_roi
    if breakeven: body["breakeven"] = True
    raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    ts = str(int(time.time() * 1000))
    sig = hmac.new(EF_SECRET.encode(), f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    r = requests.post(EF_URL, data=raw.encode("utf-8"),
                      headers={"Content-Type": "application/json", "X-Timestamp": ts, "X-Signature": sig}, timeout=10)
    r.raise_for_status()
    return r.json()

# 1번 저점 확정 → 진입, 손절은 1번 저점 바로 아래
# send_signal(f"btc-15m-{bar_ts}-1", "BTCUSDT", "open", "long", leverage=3, sl_price=low1 * 0.998, note="1번 저점")
# 2번 저점 확정 → 불타기, 손절을 2번 저점으로 올림
# send_signal(f"btc-15m-{bar_ts}-2", "BTCUSDT", "add", "long", leverage=3, sl_price=low2 * 0.998, note="2번 저점 불타기")
# 2번 저점이 깨짐 → 본절
# send_signal(f"btc-15m-{bar_ts}-be", "BTCUSDT", "update", breakeven=True, note="2번 이탈, 본절")
# 상승 확인 → 익절선
# send_signal(f"btc-15m-{bar_ts}-tp", "BTCUSDT", "update", tp_roi=30, note="익절선")
# 1번 저점까지 깨짐 → 전량 정리
# send_signal(f"btc-15m-{bar_ts}-close", "BTCUSDT", "close", note="저점 이탈")
```
주의: 텔레그램에서 사람이 "맞아"를 눌러 확정하는 흐름이면, **확정된 뒤에만** open 신호를 보낸다. 봇의 UNI 같은 종목은 WOO X Pro 앱에서 지원하지 않으므로 BTC/ETH 신호만 보낸다.

## 저점 봇 — Worker 안에 내장 (2026-09-08, hlbot 이식)
VPS 파이썬 봇(hlbot) 대신 **easy-futures Worker 가 직접** 저점을 감지하고 텔레그램으로 확인받아 자동매매를 실행한다. HMAC 릴레이·VPS 불필요.
```
[BottomWatcher DO, 60초 알람] → Hyperliquid 공개 캔들 → 마감봉 피봇 → 3의 법칙 상태머신
      → 텔레그램(관리자 chat) "N번 저점 후보 [✅ 맞아][❌ 아니야]"
      → 사람이 ✅ → insertSignal + AutoTrader 실행 (승인+켬 사용자 전원)
      → 결과 메시지: 첫 줄 요약(N명 → 성공·실패·건너뜀) + 사용자별 한 줄 `1. 아이디님 ✅ 성공 — 오른다 30 USDT 10배 (1계약) · 손절 …`
        (성공 → 실패 → 건너뜀 순, 관리자 연습 계정은 `(연습)` 표시, 사유는 auto_executions.detail. 3,800자 넘으면 여러 메시지로 나눔)
```
- 코드: `server/src/bot/` — `strategy.ts`(피봇·카운트·바닥 리테스트, hlbot 순수 로직 1:1), `monitor.ts`(감시 루프), `db.ts`(D1 0010), `signals.ts`(AutoTrader 연결), `webhook.ts`(텔레그램 명령·버튼), `BottomWatcher.ts`(DO+웹훅 자동 등록), `routes/bot.ts`(관리자 API). 테스트 60건(파이썬 테스트 이식 포함).
- 텔레그램 → 신호 매핑 (1번은 반드시 사람이 ✅. 2·3번과 이탈은 아래 '자동 처리' 참고):
  | 버튼/명령 | 신호 |
  |---|---|
  | ✅ 1 맞아 | `open` 롱 · 손절 = 1번 저가 × 0.995 · 익절 = 현재가(WOO X 마크) + 손절거리 × tpR |
  | ✅ 2·3 맞아 | `add` 불타기 · 손절 = 그 저점 × 0.995 |
  | 🗑 N부터 취소 (확정 저점 이탈) | `close` 전량 정리. 잠정(미확정) 후보만 취소되면 신호 없음 |
  | 🗑 전체 취소·리셋 (1번 이탈·바닥 갱신) | `close` |
  | 🔁 새 사이클 리셋 | `update breakeven` |
  | 무시 (이탈 알림) | 신호 없음 · 자동 정리 대기 해제 |
  | /close BTC · /be BTC · /panic | close · breakeven · BTC/ETH 모두 close |
  | 📍 수동 지정 | 신호 없음 (카운트만) |
- 설정(/bot 또는 관리자 화면): 연결 on/off, 배율(기본 3, 사용자 상한과 min), 익절 R배수(기본 1.5, 0=없음), 보낼 TF 제한, 자동 처리 on/off(`/bot auto`, 기본 on), 유예 분(`/bot grace`, 기본 3). BTC/ETH/SOL 외 코인은 알림만.
- **자동 처리 (2026-09-15)**: 1번은 항상 사람이 ✅. 그 뒤 **2·3번 후보는 유예(기본 3분) 안에 ❌ 가 없으면 BottomWatcher 틱이 자동 확정 → add 신호**. **확정 저점 이탈 알림도 유예 안에 '무시' 가 없으면 자동 취소 → close(전량 정리)**. 대상 조건 `autoEligible`: 설정 켜짐 + 신호 대상 TF + 체인의 1번이 ✅ 로 실제 신호가 나간 체인(`bot_counts.signal_id`, D1 0014). 📍 수동 지정 체인·다른 TF 는 지금처럼 버튼으로만. 대기 상태는 `bot_watch_state.break_seq/break_at/break_msg_id`, 처리 함수 `webhook.ts processDue`.
- 웹훅은 `https://easyfutures.app/api/telegram/<sha256(토큰) 앞 40자>` 로 DO 가 스스로 등록(6시간마다 확인). 헤더 `X-Telegram-Bot-Api-Secret-Token` 도 같은 값으로 검증. 관리자 chat id 외의 메시지는 무시(/start 에만 chat id 안내).
- 시크릿: `wrangler secret put TELEGRAM_BOT_TOKEN`, `wrangler secret put TELEGRAM_ADMIN_CHAT_ID`. 둘 다 없으면 봇 전체가 조용히 비활성(크론·알람은 돌지만 아무것도 보내지 않음).
- 크론 `* * * * *` 이 DO 알람을 되살린다. 관리자 화면 "저점 봇" 카드에서 감시 등록·설정·즉시 평가·웹훅 재등록 가능.
- 옛 VPS 봇(hlbot `ef-relay`)은 병행 비교용으로 남겨 두고, Worker 봇이 같은 제안을 내는 걸 확인한 뒤 종료한다.

## 자동매매 특약 (2026-09-08)
- 본문 `web/src/content/auto-terms.ts`(12개 조), 버전 `AUTO_TERMS_VERSION`(shared). 신청 화면에서 **끝까지 스크롤해야** 동의 체크가 열리고, 서버는 `autoTermsVersion === AUTO_TERMS_VERSION` 아니면 신청을 거절(`AUTO_TERMS_REQUIRED`). 동의 버전·시각은 `auto_settings.auto_terms_version / agreed_at`(D1 0011)에 남는다. 이용약관 화면 끝에도 같은 특약을 붙였다.
- 신청 한도: 신호당 비율 1~30%(저점마다 최대 3회 진입 → 최대 90%), 최대 배율 1~50배(슬라이더), 기본 손절 5~30%(슬라이더).
- **법적 한계(변호사 검토 필수)**: 약관규제법상 고의·중과실 면책, 부당한 관할 합의는 무효라 넣지 않았다. 더 큰 위험은 "타인 계좌에서 신호대로 자동 매매하고 이용료를 받는" 구조가 자본시장법상 투자일임·유사투자자문 규제에 걸릴 수 있다는 점 — 약관으로는 해결되지 않는다.

## 서버 설정
- `wrangler secret put AUTO_SIGNAL_SECRET` (예: `openssl rand -hex 32`), 봇 환경변수 `EF_SIGNAL_SECRET` 에 같은 값
- 관리자 화면 → 자동매매: 신청 승인/정지, 수동 신호(테스트), 최근 신호 로그

## 결제
자동매매는 유료. 결제 확인은 현재 수동(관리자가 확인 후 승인). 금액·방법은 [결제 안내 문구]를 자동매매 신청 화면에서 채운다.
