# easy-futures — 어르신용 쉬운 선물 브로커 (WOO X Pro)

부모 폴더 `../CLAUDE.md`의 워크플로 규칙(플랜 우선, 검증 후 완료, tasks/todo.md·lessons.md 관리)을 그대로 따른다.

## 한 줄 요약
40~70대 사용자가 **큰 글씨·큰 버튼·우리말 설명**만으로 WOO X Pro 무기한 선물(BTC/ETH/SOL)을 사고팔 수 있게 하는 모바일 PWA + 얇은 API 프록시 서버.

## 절대 규칙 (안전)
- API Secret은 **브라우저에 절대 내려보내지 않는다.** 등록 시 한 번 받아 암호화 저장, 서명은 서버(`server/`)에서만 한다.
- 사용자 간 격리: 요청마다 세션의 사용자 키로만 서명. 공유 큐·락 없이 거래소로 직행(동시 주문 지연 방지).
- 실주문은 항상 **2단계 확인**(주문 요약 문장 → "네, 주문합니다" 버튼)을 거친다.
- 신규 진입 주문은 **손절가 없이 제출할 수 없다**(preset_stop_loss_price 필수). 익절은 선택.
- 레버리지 상한은 설정값(기본 100배, 2026-09-07 사용자 결정)으로 앱에서 잠근다. 위저드 프리셋 2/5/10/20/50/100배 + 슬라이더. 거래소 max_leverage 와 min 으로 적용.
- 2026-09-18 결정: **연습 모드는 제품에서 제거.** 신규 사용자는 실거래 모드가 기본이며 신분증 승인 + API 키 전까지 주문 불가(온보딩 카드). 연습 엔진(PaperEngine)은 시세 피드·테스트·관리자(`ADMIN_LOGIN_IDS`, `ALLOW_PAPER=on` 바인딩) 전용으로만 남는다. 흐름: 가입 → 신분증 확인 → 거래소 API 키 연결 → 실거래.
- 약관 버전(`TERMS_VERSION`, shared)이 바뀌면 재동의 전까지 거래 API 차단. 임시 비밀번호 로그인은 새 비밀번호 설정 전까지 차단.
- 종목은 `shared` 의 `SYMBOLS`(BTC/ETH/SOL, 2026-09-08 SOL 추가) 하나만 고치면 시세·연습·자동매매·봇이 다 따라간다. SOL 은 1계약 = 1 SOL(≈100 USDT 명목).
- WOO X Pro는 테스트넷이 없다. 실거래 검증은 최소 수량(1계약)으로만 한다.

## 기술 스택
- `web/` : Vite + React + TypeScript + vite-plugin-pwa. 모바일 Chrome 우선, 홈화면 설치(A2HS).
- `server/`: **Cloudflare Workers + Hono**. 다중 사용자(최대 300명). 사용자별 API 키는 D1에 AES-GCM 암호화 저장, 시세 WS·연습 엔진(테스트·관리자 전용)은 Durable Object `PaperEngine`. 로컬은 `wrangler dev`. 상세 `docs/architecture.md`.
- 패키지 매니저: npm (workspaces). 테스트: vitest.
- 폰트 기본 크기 20px(보통, 기본값), 크게 25px, 아주 크게 30px. 터치 타겟 최소 56px, 색만으로 의미 전달 금지(항상 글자 병기).
- 손절/익절 프리셋 %는 **내 돈(증거금) 기준**이다(가격 변동률 아님). 가격 = 진입가 × (1 ± pct/100/레버리지) → `shared` 의 `priceAtRoi`. (2026-09-07 사용자 결정)

## 자동매매 (2026-09-07 추가)
- 구조: **저점 카운팅 봇은 Worker 안에 내장**(`server/src/bot/`, 2026-09-08 hlbot 이식): `BottomWatcher` DO 가 60초마다 Hyperliquid 캔들로 저점을 감지 → 텔레그램(관리자 chat) ✅ 확인 → `AutoTrader` DO 가 승인+켬 사용자 전원에게 순차 실행. 외부 봇용 `/api/signals`(HMAC) 도 유지. 상세 `docs/auto-trading.md`.
- 봇 규칙: **1번 진입 신호는 사람이 ✅ 를 누른 뒤에만.** 2·3번(불타기)과 확정 저점 이탈은 유예(기본 3분) 안에 ❌/무시 가 없으면 자동 처리(2026-09-15, `/bot auto off` 로 끔) — 1번이 ✅ 로 신호가 나간 체인만. 확정 저점 이탈 = 본절이 아니라 **시장가 전량 정리**. 📍 수동 지정은 신호를 내지 않는다. 텔레그램 시크릿(TELEGRAM_BOT_TOKEN/ADMIN_CHAT_ID)이 없으면 봇은 조용히 비활성.
- 신호: open / add(불타기) / update(손절·익절 갱신, breakeven) / close. 손절 필수(절대가 > % > 사용자 기본).
- 자격: 신분증 승인 + API 키(실거래 전용 — 연습 사용자는 없다, 관리자 연습 계정만 테스트용) + 약관 동의 + 신청 → 관리자 승인(결제 확인 수동). 홈에 "쉬운 거래 | 자동매매" 스위치.

## 카피 트레이딩 (2026-09-18 추가) — 상세 `docs/copy-trading.md`
- 홈 스위치 세 개: 쉬운 거래 | AI 자동매매 | 고수 따라하기(카피). 마스터(고수) = 신분증 승인 + API 키 + 관리자 승인. 팔로워도 신분증 승인 + API 키(실거래)만 — 연습 팔로우는 2026-09-18 제거, 관리자만 `ALLOW_PAPER=on` 으로 연습 테스트. 팔로워는 한 번에 한 고수만, AI 자동매매와 동시에 켤 수 없다(서버 409).
- 감시: 마스터당 `MasterWatcher` DO. 거래소 개인 WS 는 "깨우기" 용도로만 쓰고 포지션 숫자는 항상 REST(`getAccount`)로 다시 읽는다. 폴링 2~5초가 안전망. 마스터 키로 주문을 내지 않는다(읽기 전용).
- 실행: `CopyTrader` DO(AutoTrader 와 같은 샤딩). 비례 크기 = `server/src/copy/sizing.ts`(마스터 증거금 비율 × 따라갈 돈). 손절·익절·배율은 **고수와 완전히 동일**(2026-09-18 사용자 결정: 고수가 손절을 지우면 팔로워도 지움, 손실 한도가 마지막 방어선). 고수 손절이 없을 때만 팔로워 설정 % 로 손절을 붙여 진입. 팔로워가 직접 잡은 포지션은 건드리지 않는다(장부 `copy_positions` 수량만 정리). 손실 한도 도달 시 멈추고 전량 정리.
- 약관: 팔로워 특약 `COPY_TERMS_VERSION`, 고수 약관 `MASTER_TERMS_VERSION`(shared). 버전이 오르면 재동의 전까지 정지.

## 디렉터리
- `docs/PRD.md` 제품 요구사항, `docs/architecture.md` 다중 사용자·Cloudflare 구조, `docs/api-contract.md` 서버↔웹 계약, `docs/woox-pro-api.md` API 정리(엔드포인트·서명·CORS 실측)
- `tasks/todo.md` 진행 체크리스트, `tasks/lessons.md` 교훈

## 용어 (UI에서 쓰는 우리말)
| 거래 용어 | 화면 표기 |
|---|---|
| Long / Short | 오른다에 걸기 / 내린다에 걸기 |
| Entry price | 산 가격(진입가) |
| Avg price | 평균 가격(평단) |
| Stop loss | 손절가 — "여기까지 떨어지면 자동으로 정리" |
| Take profit | 익절가 — "여기까지 오르면 자동으로 정리" |
| Leverage | 배율 — "내 돈의 N배 효과, 위험도 N배" |
| Liquidation | 강제정리 가격 |
| Close position | 정리하기 |
| Unrealized PnL | 지금 팔면 손익 |
