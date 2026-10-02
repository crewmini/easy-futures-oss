# 아키텍처 v2 — 다중 사용자(최대 300명) · Cloudflare (2026-09-07 개정)

## 요구 변경
- 사용자 각자가 자기 WOO X Pro API 키를 등록한다. 최대 200~300명 동시 사용.
- 여러 명이 동시에 주문해도 서로 기다리지 않아야 한다(공유 큐·공유 레이트리밋 금지).
- 서버는 Cloudflare에 올린다.

## 구성
```
[모바일 PWA (Cloudflare Pages 또는 Worker 정적서빙)]
   ├─ 공개 시세 WS 직결 wss://cloud-ws.wooxpro.com/api   ← 서버 부하 0
   └─ /api/* ──▶ [Cloudflare Worker: Hono]
                    ├─ 세션 쿠키 검증 → D1에서 사용자·암호화된 API 키 로드
                    ├─ live 모드: 사용자 키로 서명 → cloud-api.wooxpro.com 직행 (요청당 1 fetch)
                    └─ paper 모드(관리자·테스트 전용, `ALLOW_PAPER=on`): Durable Object `PaperEngine`(싱글턴) 호출
                                     └─ 공개 티커 WS 1개 유지(시세 피드는 모든 모드가 공유), 연습 계좌의 손절/익절/강제정리 판정
```

## 왜 이렇게 하면 동시 사용에 지연이 없는가
- Worker는 요청마다 독립 실행되고 엣지에서 자동 수평 확장된다. 사용자 A의 주문과 B의 주문은 서로 다른 격리 환경에서 각자의 키로 서명해 거래소로 바로 나간다.
- WOO X Pro 프라이빗 레이트리밋은 **API 키 단위**(주문 24회/2초). 사용자마다 키가 다르므로 300명이 동시에 주문해도 한도를 나눠 쓰지 않는다.
- 남는 지연은 거래소 자체 응답(대략 100~300ms)뿐이다. 서버에서 큐·락·직렬화를 두지 않는다.
- 공개 시세는 브라우저가 거래소 WS에 직접 붙으므로 사용자 수와 무관하게 서버를 거치지 않는다.

## 데이터 (D1 = SQLite)
- `users(id, login_id UNIQUE, pw_hash, pw_salt, created_at)` — 비밀번호 PBKDF2-SHA256(WebCrypto) 해시
- `api_keys(user_id PK, enc BLOB, iv BLOB, updated_at)` — `{key, secret, memo}` JSON을 AES-256-GCM으로 암호화. 마스터 키는 Worker Secret `MASTER_KEY`
- `settings(user_id PK, mode, max_leverage, max_amount_usdt, usdt_krw)` — `mode` 기본 `live`(2026-09-18 연습 모드 제거). `paper` 는 `ADMIN_LOGIN_IDS` + `ALLOW_PAPER=on` 인 관리자만
- `sessions(token PK, user_id, expires_at)` — HttpOnly·Secure·SameSite=Lax 쿠키, 30일
- 연습 계좌 상태는 `PaperEngine` DO의 SQLite 스토리지에 사용자별로 저장 (관리자 테스트·vitest 전용)
- 보존 정리(2026-09-18, `server/src/maintenance.ts`): 크론이 매시 7분에 `runRetention` 실행. `auto_executions`·`auto_signals`·`copy_executions`·`copy_events` 180일, 끝난 `bot_counts`(cancelled/replaced/vetoed) 90일, `login_attempts`(잠금 해제·마지막 실패 후 하루)·`signup_attempts`·`login_ip_attempts` 하루. 표마다 500건씩(rowid 부분 선택), 자식 → 부모 순서라 실행 기록이 남은 신호·이벤트는 다음 시간에 지운다. 활성 팔로우·`copy_positions`·진행 중 저점 체인은 건드리지 않는다
- 로그인 보호: 아이디@IP 5회 실패 10분 잠금(`login_attempts`) + IP 당 실패 10분 30회(`login_ip_attempts`, 해시 계산 전에 검사, 성공은 안 셈). 관리자 임시 비밀번호는 `users.pw_temp_expires_at`(24시간) 지나면 로그인 403

## 보안
- Secret은 브라우저에 절대 내려가지 않는다. 등록 화면에서 한 번 입력 → 서버가 암호화 저장 → 이후 화면에는 키 앞 6자리만 표시.
- 등록 시 `assets-detail`을 호출해 키가 유효한지 즉시 검증.
- Workers는 고정 egress IP가 없다 → 거래소 API 키의 **IP 바인딩은 비워둔다**. 대신 권한을 `Read-Only, Future-Trade`(출금 불가)로만 만들도록 안내. 고정 IP가 꼭 필요하면 Cloudflare Zero Trust 전용 egress(유료) 또는 별도 VPS 프록시 검토.
- 가입은 `INVITE_CODE` Secret이 맞아야 가능(무작위 가입 방지). 가족이 대신 가입·키 등록해 주는 시나리오.
- 로그인 5회 실패 시 10분 잠금(D1 `login_attempts`).

## 라이브 모드 폴링 비용
- `/api/state` 1회 = 거래소 호출 2~3개(자산, 포지션, 미체결 TP/SL). 웹은 3초 간격, 화면이 숨겨지면 중단.
- 300명 × 20회/분 × 3 = 최대 1,080 fetch/분. Worker 무료 한도(10만/일)를 넘으므로 **Workers Paid($5/월)** 필요. 이후 개선안: 사용자별 DO에서 프라이빗 WS를 유지해 푸시로 전환.

## 로컬 개발
- `wrangler dev` (miniflare가 D1·DO를 로컬 에뮬레이션) → http://localhost:8787
- 웹은 Vite dev 서버가 `/api`를 8787로 프록시.
- 배포: `wrangler deploy` + `wrangler d1 migrations apply`. 웹은 Worker의 `assets` 바인딩으로 같은 도메인에서 서빙(CORS 불필요).
