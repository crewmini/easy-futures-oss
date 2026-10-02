import { applyD1Migrations, env } from 'cloudflare:test';
import { notifyDeps } from '../copy/notify.js';

// 카피 운영 알림(관리자 텔레그램)은 테스트에서 실제로 보내지 않는다 — 바깥 fetch 가 테스트 경계를 넘기면 workerd 'internal error' 소음. 문구·중복 제거는 copy/notify.test 가 직접 스텁으로 검증
notifyDeps.send = async () => undefined;

// 각 테스트 파일 실행 전 D1 마이그레이션 적용
await applyD1Migrations((env as { DB: D1Database }).DB, (env as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
