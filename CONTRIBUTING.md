# 함께 개발하기 / Contributing

## 시작
```bash
git clone https://github.com/crewmini/easy-futures.git
cd easy-futures
npm install
cp server/.dev.vars.example server/.dev.vars     # 로컬 시크릿 (git 에 안 올라감). MASTER_KEY 는 `openssl rand -base64 32` 로 채운다
npm run db:migrate:local --workspace=server       # 최초 1회
npm run dev                                       # server :8787 + web :5173
```
로컬은 **연습 모드(가짜 돈)** 로만 동작합니다. 거래소 키 없이 가입·주문·자동매매 흐름을 다 볼 수 있습니다.

## 작업 흐름
1. `main` 에서 브랜치를 만듭니다. `feat/...`, `fix/...`, `docs/...`
2. 바꾸기 전에 `CLAUDE.md`(안전 규칙·용어)와 관련 `docs/` 를 읽습니다.
3. 테스트와 타입검사를 통과시킵니다.
   ```bash
   npm test          # server: vitest (workerd 안에서 D1·DO 까지 실제로 돌림)
   npm run typecheck # server + web
   ```
4. PR 을 엽니다. 무엇을·왜 바꿨는지와 확인 방법을 적습니다. CI(GitHub Actions)가 같은 검사를 돌립니다.
5. 배포(`wrangler deploy`, D1 마이그레이션 적용)는 **저장소 관리자만** 합니다. PR 이 병합되면 관리자가 배포합니다.

## 지켜야 할 것
- 시크릿·실사용자 데이터는 절대 커밋하지 않습니다. `SECURITY.md` 참고.
- 사용자 화면은 40~70대 기준입니다. 큰 글씨·큰 버튼(56px 이상)·우리말 설명, 색만으로 의미를 전달하지 않습니다.
- 주문·자동매매 경로를 건드리면 `docs/auto-trading.md` 와 테스트를 같이 고칩니다. 손절 없는 진입, 2단계 확인 생략, 브라우저로 시크릿 전달은 리뷰에서 거절됩니다.
- 실거래(WOO X Pro)에는 테스트넷이 없습니다. 실계좌 검증은 관리자가 1계약으로만 합니다.

## 코드 구조
| 폴더 | 내용 |
|---|---|
| `shared/` | 서버·웹 공용 타입, 종목 목록(`SYMBOLS`), 손절가 계산 |
| `server/` | Cloudflare Workers + Hono. `routes/`(API), `adapters/`(paper·woox), `paper/`(연습 엔진 DO), `auto/`(AI 자동매매 실행 DO), `bot/`(저점 카운팅 봇 + 텔레그램) |
| `web/` | Vite + React PWA |
| `docs/` | PRD, 아키텍처, API 계약, 거래소 API 실측, 자동매매 설계, 사용 설명서 |
