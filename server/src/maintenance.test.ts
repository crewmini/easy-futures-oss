// 크론 보존 정리 (감사 A12·B20·B21): 오래된 행만 지우고 최근 행·진행 중 체인·자식이 남은 부모는 남긴다
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runRetention, RETENTION_DAYS, BOT_RETENTION_DAYS } from './maintenance.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OLD = NOW - (RETENTION_DAYS + 1) * DAY;
const RECENT = NOW - 10 * DAY;
const db = () => env.DB;
const count = async (table: string) => (await db().prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n;

beforeEach(async () => {
  await db().batch(['auto_executions', 'auto_signals', 'copy_executions', 'copy_events', 'bot_counts', 'login_attempts', 'signup_attempts', 'login_ip_attempts'].map((t) => db().prepare(`DELETE FROM ${t}`)));
});

describe('runRetention', () => {
  it('deletes old executions/signals/events and keeps recent ones', async () => {
    await db().batch([
      db().prepare("INSERT INTO auto_signals (id, source, symbol, action, created_at) VALUES ('s-old', 'bot', 'BTCUSDT', 'open', ?), ('s-new', 'bot', 'BTCUSDT', 'open', ?)").bind(OLD, RECENT),
      db().prepare("INSERT INTO auto_executions (signal_id, user_id, mode, status, created_at) VALUES ('s-old', 1, 'live', 'ok', ?), ('s-new', 1, 'live', 'ok', ?)").bind(OLD, RECENT),
      db().prepare("INSERT INTO copy_events (id, master_id, seq, symbol, kind, direction, before_contracts, after_contracts, price, leverage, master_equity, created_at) VALUES ('e-old', 1, 1, 'BTCUSDT', 'open', 'long', 0, 1, 80000, 5, 1000, ?), ('e-new', 1, 2, 'BTCUSDT', 'close', 'long', 1, 0, 80000, 5, 1000, ?)").bind(OLD, RECENT),
      db().prepare("INSERT INTO copy_executions (event_id, follower_id, mode, status, created_at) VALUES ('e-old', 2, 'live', 'ok', ?), ('e-new', 2, 'live', 'ok', ?)").bind(OLD, RECENT),
    ]);
    const r = await runRetention(env, NOW);
    expect(r).toMatchObject({ auto_executions: 1, auto_signals: 1, copy_executions: 1, copy_events: 1 });
    expect((await db().prepare('SELECT id FROM auto_signals').all()).results).toEqual([{ id: 's-new' }]);
    expect((await db().prepare('SELECT id FROM copy_events').all()).results).toEqual([{ id: 'e-new' }]);
    expect(await count('auto_executions')).toBe(1);
    expect(await count('copy_executions')).toBe(1);
  });

  it('keeps a parent whose executions are still there (batch cap), and finishes on the next run', async () => {
    const stmts = [db().prepare("INSERT INTO copy_events (id, master_id, seq, symbol, kind, direction, before_contracts, after_contracts, price, leverage, master_equity, created_at) VALUES ('e-big', 1, 1, 'BTCUSDT', 'open', 'long', 0, 1, 80000, 5, 1000, ?)").bind(OLD)];
    for (let i = 0; i < 520; i++) stmts.push(db().prepare("INSERT INTO copy_executions (event_id, follower_id, mode, status, created_at) VALUES ('e-big', ?, 'live', 'ok', ?)").bind(i + 1, OLD));
    await db().batch(stmts);
    const first = await runRetention(env, NOW);
    expect(first.copy_executions).toBe(500);
    expect(first.copy_events).toBe(0);            // 자식 20건이 남아 있어 부모는 이번엔 안 지움
    const second = await runRetention(env, NOW);
    expect(second).toMatchObject({ copy_executions: 20, copy_events: 1 });
  });

  it('bot_counts: only finished chains older than 90 days; active chains stay', async () => {
    const botOld = NOW - (BOT_RETENTION_DAYS + 1) * DAY;
    await db().prepare("INSERT INTO bot_counts (coin, tf, seq, ts_ms, low, status, created_at) VALUES ('BTC','1h',1,1,1,'cancelled',?), ('BTC','1h',1,1,1,'replaced',?), ('BTC','1h',1,1,1,'vetoed',?), ('BTC','1h',1,1,1,'confirmed',?), ('BTC','1h',2,1,1,'proposed',?), ('ETH','1h',1,1,1,'cancelled',?)").bind(botOld, botOld, botOld, botOld, botOld, RECENT).run();
    const r = await runRetention(env, NOW);
    expect(r.bot_counts).toBe(3);
    const left = (await db().prepare('SELECT status FROM bot_counts ORDER BY status').all<{ status: string }>()).results.map((x) => x.status);
    expect(left).toEqual(['cancelled', 'confirmed', 'proposed']);   // 최근 cancelled + 진행 중 둘
  });

  it('login/signup counters: expired locks and day-old rows go, active lock and fresh fails stay', async () => {
    await db().batch([
      db().prepare('INSERT INTO login_attempts (login_id, fails, locked_until, updated_at) VALUES (?, 5, ?, ?)').bind('a@1.1.1.1', NOW - 2 * DAY, NOW - 2 * DAY),   // 잠금 풀린 지 이틀
      db().prepare('INSERT INTO login_attempts (login_id, fails, locked_until, updated_at) VALUES (?, 5, ?, ?)').bind('b@1.1.1.1', NOW + 60_000, NOW),          // 지금 잠김
      db().prepare('INSERT INTO login_attempts (login_id, fails, locked_until, updated_at) VALUES (?, 2, NULL, ?)').bind('c@1.1.1.1', NOW - 2 * DAY),           // 옛 실패 2회
      db().prepare('INSERT INTO login_attempts (login_id, fails, locked_until, updated_at) VALUES (?, 2, NULL, ?)').bind('d@1.1.1.1', NOW - 60_000),            // 방금 실패 2회
      db().prepare('INSERT INTO login_attempts (login_id, fails, locked_until) VALUES (?, 1, NULL)').bind('e@1.1.1.1'),                                          // 0022 이전 행 (updated_at 없음)
      db().prepare('INSERT INTO signup_attempts (ip, count, window_start) VALUES (?, 3, ?), (?, 3, ?)').bind('1.1.1.1', NOW - 2 * DAY, '2.2.2.2', NOW - 60_000),
      db().prepare('INSERT INTO login_ip_attempts (ip, count, window_start) VALUES (?, 3, ?), (?, 3, ?)').bind('1.1.1.1', NOW - 2 * DAY, '2.2.2.2', NOW - 60_000),
    ]);
    const r = await runRetention(env, NOW);
    expect(r).toMatchObject({ login_attempts: 3, signup_attempts: 1, login_ip_attempts: 1 });
    const left = (await db().prepare('SELECT login_id FROM login_attempts ORDER BY login_id').all<{ login_id: string }>()).results.map((x) => x.login_id);
    expect(left).toEqual(['b@1.1.1.1', 'd@1.1.1.1']);
  });

  it('is a no-op on an empty database', async () => {
    const r = await runRetention(env, NOW);
    expect(Object.values(r).every((n) => n === 0)).toBe(true);
  });
});
