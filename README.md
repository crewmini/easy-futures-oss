# Easy futures — 어르신용 선물거래 앱 (WOO X Pro)

큰 글씨·큰 버튼·우리말 설명만으로 BTC/ETH/SOL 무기한 선물을 사고팔 수 있는 모바일 PWA와, 사용자별 API 키로 거래소에 직행하는 Cloudflare Workers 서버.

## 구성
| 폴더 | 내용 |
|---|---|
| `web/` | Vite + React + TypeScript PWA (모바일 Chrome, 홈 화면 추가) |
| `server/` | Cloudflare Workers + Hono. D1(사용자·암호화 키·설정), Durable Object `PaperEngine`(시세 WS + 테스트·관리자 전용 연습 엔진) |
| `shared/` | 서버·웹 공용 타입과 계산 함수 |
| `docs/` | PRD, 아키텍처, API 계약, WOO X Pro API 정리(유동성 실측 포함) |

## 로컬 실행
```bash
npm install
npm run db:migrate:local --workspace=server   # 최초 1회
npm run dev --workspace=server                 # http://localhost:8787 (wrangler dev)
npm run dev --workspace=web                    # http://localhost:5173 (/api → 8787 프록시)
```
가입 초대 코드(로컬): `server/.dev.vars` 의 `INVITE_CODE` (기본 `dev1234`).

웹만 따로 볼 때(가짜 API): `node web/dev/mock-api.mjs` 후 `API_TARGET=http://localhost:8790 npm run dev --workspace=web`.

## 테스트 / 타입검사
```bash
npm test
npm run typecheck
```

## 배포 (요약, 상세는 server/README.md)
1. `wrangler d1 create easy-futures` → `wrangler.toml` 의 database_id 갱신
2. `wrangler secret put MASTER_KEY` (32바이트 base64), `wrangler secret put INVITE_CODE`
3. `npm run build --workspace=web` → `npm run db:migrate --workspace=server` → `npm run deploy --workspace=server`
4. Workers Paid 플랜 권장(300명 폴링 트래픽). Workers는 고정 IP가 없으므로 거래소 API 키의 IP 바인딩은 비워 두고 권한은 Future-Trade만.

## 함께 개발하기
- 시작 방법·작업 흐름: `CONTRIBUTING.md`. 보안 규칙: `SECURITY.md`. 제품 규칙·용어: `CLAUDE.md`.
- 저장소에는 시크릿이 없습니다. `server/wrangler.toml` 의 도메인·D1 id 는 관리자 Cloudflare 계정 기준이라 다른 계정에서는 배포되지 않습니다(로컬 `wrangler dev` 는 무관). 배포는 관리자만 합니다.
- 라이선스: MIT (`LICENSE`).

## 꼭 읽을 것
`docs/woox-pro-api.md` 의 **유동성 실측** 절. WOO X Pro 선물 호가창이 사실상 비어 있어(BTC 체결가 644달러), 실주문 전 1계약 테스트로 체결 품질을 반드시 확인해야 한다.
