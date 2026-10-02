# easy-futures 서버 (Cloudflare Workers + Hono)

다중 사용자(≤300명) API 프록시. 사용자별 WOO X Pro API 키를 D1에 AES-256-GCM으로 암호화 저장하고, 서명은 서버에서만 한다.
공개 시세 WebSocket 과 연습(paper) 엔진은 Durable Object `PaperEngine`(싱글턴)이 담당한다. **연습 모드는 2026-09-18 제품에서 제거**됐다 — 일반 사용자는 실거래만(신분증 승인 + API 키 전까지 주문 불가), 엔진은 시세 피드·테스트·관리자(`ADMIN_LOGIN_IDS` 에 있는 아이디 + `[vars] ALLOW_PAPER = "on"`) 전용이다.
API 계약은 `../docs/api-contract.md`(v0.2), 구조는 `../docs/architecture.md`.

## 로컬 개발
```bash
# 저장소 루트에서 (npm workspaces)
npm install

cd server
cp .dev.vars.example .dev.vars        # MASTER_KEY 를 채운다: openssl rand -base64 32
npm run db:migrate:local              # 로컬 D1(miniflare) 에 migrations/ 적용
npm run dev                           # http://localhost:8787  (wrangler dev)
```
- `.dev.vars` 는 git 에 올라가지 않는다. `INVITE_CODE` 기본값은 `dev1234`.
- 연습 모드(가짜 돈)는 `ADMIN_LOGIN_IDS` 에 있는 아이디가 `ALLOW_PAPER=on` 일 때만 `PUT /api/settings {mode:'paper'}` 로 켤 수 있다. 그 외에는 400 `PAPER_DISABLED`.
- 웹(`../web`)은 Vite dev 서버가 `/api` 를 8787 로 프록시한다. `../web/dist` 가 있으면 `wrangler dev` 가 그 정적 파일도 같이 서빙한다(없어도 `/api` 는 동작).
- 빠른 확인:
  ```bash
  curl localhost:8787/api/health
  curl -c jar -H 'content-type: application/json' \
    -d '{"loginId":"test1","password":"123456","inviteCode":"dev1234"}' localhost:8787/api/auth/signup
  curl -b jar localhost:8787/api/state
  ```

## 테스트 / 타입검사
```bash
npm test          # vitest — @cloudflare/vitest-pool-workers 로 workerd 안에서 실행 (D1·DO 포함, 실제 네트워크 없음)
npm run typecheck
```
- `src/**/*.test.ts`: 서명 벡터, 암호화 왕복, 연습 엔진(손절/익절/강제정리), 요청 검증, 라우트 통합(가입→로그인→상태→주문→정리).
- 테스트에서는 `PAPER_FEED=off` 로 시세 피드를 끄고 DO 의 `/__test/prices` 로 시세를 주입한다(피드가 켜져 있으면 이 경로는 404).

## 배포
```bash
# 1) D1 만들기 → 출력된 database_id 를 wrangler.toml 의 [[d1_databases]].database_id 에 넣는다
npx wrangler d1 create easy-futures
npm run db:migrate                    # 원격 D1 에 마이그레이션

# 2) 비밀값
npx wrangler secret put MASTER_KEY    # 32바이트 base64 (openssl rand -base64 32). 바꾸면 저장된 API 키를 모두 다시 등록해야 한다
npx wrangler secret put INVITE_CODE   # 가입 초대 코드

# 3) 웹 빌드 후 배포 (wrangler.toml 의 [assets] directory = ../web/dist)
npm run build --workspace=web
npm run deploy
```
- 요금: `/api/state` 3초 폴링 × 사용자 수 때문에 **Workers Paid** 플랜을 권장(`docs/architecture.md`). Durable Object 는 SQLite 백엔드(`new_sqlite_classes`)라 무료 플랜에서도 생성 가능.
- `compatibility_date` 는 설치된 workerd 가 지원하는 날짜여야 한다(2026-09-07 기준 최신 지원 2026-08-22 → `2026-08-01` 사용).

## 다른 Cloudflare 계정에서 올리기 (협업자 개발 서버)
운영(easyfutures.app)과 완전히 분리된 인스턴스가 된다 — 회원·신분증·API 키·자동매매 승인 모두 따로. 운영 데이터는 옮기지 않는다.
1. `wrangler.toml`: `CANONICAL_HOST = ""` (또는 자기 도메인), `routes` 블록 삭제(또는 자기 도메인), `database_id` 는 `npx wrangler d1 create easy-futures` 결과로 교체.
2. `web/.env.production`: `VITE_CANONICAL_HOST=` 비움. → `npm run build --workspace=web`
3. 시크릿: `MASTER_KEY`(필수), `ADMIN_LOGIN_IDS`(자기 아이디), 필요하면 `INVITE_CODE`. **텔레그램은 BotFather 에서 새 봇을 만들어 자기 토큰만** 넣는다. 운영 토큰을 넣으면 운영 봇의 웹훅이 개발 서버로 넘어가 운영 버튼이 멈춘다.
4. `npm run db:migrate` → `npm run deploy`. 주소는 `https://easy-futures.<계정>.workers.dev`.
5. 확인: `/api/health`, 가입 → `/api/state`(신분증·키 전까지 온보딩 상태, 주문 400). 주문 흐름을 돌려 보려면 관리자 아이디(`ADMIN_LOGIN_IDS`) + `ALLOW_PAPER = "on"` 으로 연습 모드를 켠다. 실거래·자동매매 실계좌 검증은 운영 관리자만 한다.

## 거래소 API 키 안내 (사용자에게)
- Workers 는 **고정 egress IP 가 없다** → WOO X Pro 에서 키를 만들 때 **IP 바인딩(화이트리스트)은 비워 둔다**.
- 권한은 **Read-Only + Future-Trade 만** (출금·현물 권한 금지). Memo 는 서명에 쓰이므로 키·시크릿과 함께 그대로 입력해야 한다.
- 키는 `PUT /api/keys` 에서 `assets-detail` 호출로 검증한 뒤에만 저장된다. 화면에는 앞 6자만 보여 준다.
- 고정 IP 가 꼭 필요하면 Cloudflare Zero Trust 전용 egress(유료) 또는 별도 VPS 프록시를 검토.

## 구조
```
src/index.ts           Hono 앱 진입점 + 전역 오류 처리, PaperEngine export
src/routes/            auth(가입/로그인/잠금), keys(키 등록/삭제), trade(state/order/position/settings/paper), public(health/klines)
src/auth.ts            ef_session 쿠키 미들웨어 (HttpOnly, SameSite=Lax, localhost 는 Secure 생략, 30일)
src/db.ts              D1 헬퍼 + getUserContext (복호화한 키를 격리환경 메모리에 60초 캐시)
src/crypto.ts          PBKDF2-SHA256(100k)·AES-256-GCM·랜덤 토큰 (WebCrypto)
src/sign.ts            WOO X Pro HMAC 서명 (WebCrypto, async)
src/woox/client.ts     REST 클라이언트 (사용자별 자격증명, 10초 타임아웃, WooxError)
src/adapters/          BrokerAdapter: paper(DO 위임) / woox(실거래)
src/paper/engine.ts    순수 연습 엔진 (테스트 대상)
src/paper/PaperEngine.ts Durable Object: 시세 WS + REST 폴백, 계좌 저장, 트리거 판정, 알람 워치독
src/market.ts          계약 상세 10분 캐시 + 폴백 상수
migrations/            D1 스키마
```

## 시세 피드 동작 (PaperEngine)
- `wss://cloud-ws.wooxpro.com/api?protocol=1.1` 에 `futures/ticker:BTCUSDT`, `futures/ticker:ETHUSDT` 구독. 15초 동안 메시지가 없으면 `{"action":"ping"}`.
- 알람이 20초마다 워치독으로 돌며 끊겼으면 재연결하고, 그동안은 3초 간격 REST 폴링(`/contract/public/details` 의 `index_price`)으로 대체한다.
  실측상 details 의 `last_price` 는 얇은 호가 때문에 비정상 값이 오므로 쓰지 않는다.
- DO 콜드 스타트 직후에는 REST 로 한 번 채워 첫 요청부터 시세가 있게 한다.
- `AppState.connected` = 두 종목 모두 시세가 30초 이내.

## 알려진 제한 / TODO
- 실거래 어댑터의 `position-v2` 방향 필드(`position_side` vs `position_type`), 플랜 주문 조회(`current-plan-order`)·취소 경로는 BitMart V2 기준 가정. 실계정 1계약으로 검증 필요.
- 복호화 키 캐시는 격리환경(isolate)별 60초라, 키 삭제 후 다른 엣지에서 최대 60초 동안 옛 키가 쓰일 수 있다.
- 연습 엔진의 강제정리는 `estimateLiquidation`(유지증거금률 0.5%) 근사치.

## 마스터 키(MASTER_KEY) 교체 절차
API 키·신분증 사진은 MASTER_KEY(AES-256-GCM)로 암호화되어 있다. 교체는 이전 키를 잠시 함께 두는 방식이다.
1. 새 키 생성: `openssl rand -base64 32`
2. 이전 키를 보관: `wrangler secret put MASTER_KEY_PREV` (현재 MASTER_KEY 값 입력)
3. 새 키 등록: `wrangler secret put MASTER_KEY` (1의 값)
4. 관리자 계정으로 로그인한 상태에서 `POST /api/admin/rotate-keys` 호출 → 이전 키로 암호화된 모든 행을 새 키로 재암호화 (처리 수 반환). 호출 전에도 사용자가 접근한 행은 자동으로 재암호화된다.
5. 결과의 처리 수가 0이 될 때까지 4를 반복한 뒤 `wrangler secret delete MASTER_KEY_PREV`.
주의: MASTER_KEY_PREV 없이 MASTER_KEY 만 바꾸면 기존 키·사진을 영원히 풀 수 없다.

## 비밀번호 초기화
관리자 화면(설정 → 관리자 → 비밀번호 초기화)에서 아이디를 넣으면 임시 비밀번호(숫자 8자리)가 나온다. 기존 세션은 모두 끊기고, 회원은 로그인 직후 새 비밀번호를 정해야 앱을 쓸 수 있다.

## 약관 변경
`shared/src/index.ts` 의 `TERMS_VERSION` 을 올리면(예: 2026-10-01) 모든 회원이 다음 접속 때 약관을 다시 읽고 동의해야 거래 API 를 쓸 수 있다. 약관 본문은 `web/src/content/terms.ts`.

## 회원 탈퇴
설정 → 계정 → 회원 탈퇴 (비밀번호 확인 + 길게 누르기). API 키·신분증·세션·설정·제휴 연결 삭제, users 행은 `deleted_<id>` 로 익명화되고 deleted_at 만 남는다. 관리자 계정은 탈퇴 불가.

## 저점 봇 (텔레그램) 연결
1. BotFather 에서 봇 생성 → `npx wrangler secret put TELEGRAM_BOT_TOKEN`
2. 그 봇에 `/start` 를 보내면 chat_id 가 답장으로 옴 → `npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID`
3. 1분 안에 크론이 DO 알람을 깨우고 DO 가 웹훅을 스스로 등록한다. 텔레그램에서 `/watch BTC 15m 1h` 로 시작.
4. 관리자 화면 → 저점 봇 카드에서 상태 확인 (웹훅 재등록·즉시 평가 버튼).
토큰 교체 시 1번만 다시 하면 웹훅 주소(토큰 해시)도 바뀌어 자동 재등록된다.
