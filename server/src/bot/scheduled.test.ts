// 크론 → scheduled 핸들러 → BottomWatcher 알람이 걸리는지
import { it, expect } from 'vitest';
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index.js';

it('scheduled kick arms the BottomWatcher alarm', async () => {
  const stub = env.BOT.get(env.BOT.idFromName('global'));
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
  const after = (await (await stub.fetch('https://bot/status')).json()) as { alarm: number | null };
  expect(after.alarm).toBeGreaterThan(Date.now() - 5000);
});
