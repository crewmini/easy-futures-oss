// /api/keys — 거래소 API 키 등록/삭제. 시크릿은 저장 즉시 암호화되며 어디에도 평문으로 남지 않는다.
import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from '../auth.js';
import { aesEncrypt } from '../crypto.js';
import { deleteApiKey, saveApiKey } from '../db.js';
import { badRequest } from '../errors.js';
import { readJson } from '../http.js';
import { log } from '../log.js';
import { makeRateGate } from '../woox/RateGate.js';
import { validateApiKeyBody } from '../validate.js';
import { WooxClient, WooxError } from '../woox/client.js';
import { disableAuto } from '../auto/db.js';
import { getMaster, setMasterStatus, stopFollowsOfMaster, stopFollowsOfUser } from '../copy/db.js';
import { masterStub } from '../copy/MasterWatcher.js';

export const keyRoutes = new Hono<AppEnv>();
keyRoutes.use('*', authMiddleware);

keyRoutes.put('/', async (c) => {
  const ctx = c.get('ctx');
  const creds = validateApiKeyBody(await readJson(c));
  // 저장 전 거래소에서 키 검증 (assets-detail)
  const client = new WooxClient({ credentials: creds, gate: makeRateGate(c.env) });
  try {
    await client.getAssets();
  } catch (e) {
    const msg = e instanceof WooxError ? e.message : (e as Error).message;
    log.warn('api key validation failed', { userId: ctx.user.id, message: msg });
    throw badRequest(`거래소가 키를 거절했어요: ${msg}`, 'KEY_REJECTED');
  }
  // 포지션 모드: 앱은 단방향(one_way_mode) 가정 — side 1/4 진입, 3/2 정리. 양방향(hedge)이면 정리 주문이 반대 포지션을 열 수 있어 등록을 막는다.
  // 조회가 실패하면(엔드포인트 없음·오류) 막지 않는다 — 확인되지 않은 API 때문에 등록을 막지 않는다 (docs/copy-trading.md '포지션 모드 실측')
  const positionMode = await client.getPositionMode().catch((e) => { log.warn('get-position-mode failed (allowing registration)', { userId: ctx.user.id, message: (e as Error).message }); return null; });
  if (positionMode && positionMode.toLowerCase().startsWith('hedge')) {
    log.warn('api key rejected: hedge position mode', { userId: ctx.user.id, positionMode });
    throw badRequest('거래소 계정이 양방향(헤지) 모드예요. WOO X Pro 설정에서 단방향 모드로 바꾼 뒤 다시 등록해 주세요', 'HEDGE_MODE');
  }
  if (positionMode !== null) log.info('api key position mode', { userId: ctx.user.id, positionMode });
  const { enc, iv } = await aesEncrypt(c.env.MASTER_KEY, JSON.stringify(creds));
  const apiKeyPreview = creds.apiKey.slice(0, 6) + '…';
  await saveApiKey(c.env.DB, ctx.user.id, enc, iv, apiKeyPreview);
  return c.json({ ok: true, apiKeyPreview });
});

keyRoutes.delete('/', async (c) => {
  const ctx = c.get('ctx');
  await deleteApiKey(c.env.DB, ctx.user.id);
  // 모드는 그대로 실거래 — 키가 없으면 /api/state 가 needsSetup 을 돌려주고 웹이 등록 안내를 띄운다 (연습 모드 제거, 2026-09-18)
  // 실거래 키가 사라지면 자동매매가 거래소 실포지션을 방치한다 → 끄고 사유를 남긴다 (감사 H3)
  const autoDisabled = await disableAuto(c.env.DB, ctx.user.id, 'API 키를 지워서 AI 자동매매를 껐어요. 거래소에 남은 포지션은 직접 확인하세요');
  // 카피: 팔로워면 팔로우 정지, 승인된 고수면 감시 키가 없어졌으니 중지 + 그 팔로워 전원 정지 (docs/copy-trading.md §1)
  const copyStopped = await stopFollowsOfUser(c.env.DB, ctx.user.id, 'no_api_key');
  let masterSuspended = false;
  if ((await getMaster(c.env.DB, ctx.user.id))?.status === 'approved') {
    masterSuspended = await setMasterStatus(c.env.DB, ctx.user.id, 'suspended', 'system', 'API 키 삭제');
    await stopFollowsOfMaster(c.env.DB, ctx.user.id, 'master_suspended');
    await masterStub(c.env, ctx.user.id).fetch('https://master/stop', { method: 'POST' }).catch(() => null);
    log.info('copy master suspended (api key deleted)', { userId: ctx.user.id });
  }
  return c.json({ ok: true, autoDisabled, copyStopped, masterSuspended });
});
