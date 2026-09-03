/**
 * Operator-action ledger store (#5594) — recorder contract + read filters.
 *
 * Runs on the FILE backend (NODE_ENV=test), which is exactly the escape hatch
 * that lets the instrumented route suites assert a persisted row without a
 * database. The Postgres round-trip is covered by `userActions.db.test.js`
 * (`npm run test:db`).
 *
 * What is pinned here is the stuff a higher-level test cannot pin cheaply: the
 * redaction/truncation guarantee (a security boundary), the closed-vocabulary
 * refusal, idempotency, and the two retention bounds — all with the caps lowered
 * so the test proves the behavior instead of the constant.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-user-actions-' });
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  PAYLOAD_STRING_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  __setUserActionRetention,
  clampSummary,
  listUserActions,
  normalizeListOptions,
  recordUserAction,
  redactPayload,
} = await import('./userActions.js');

const EVENTS_FILE = join(tempRoot, 'user-action-events.json');

// Fixture timestamps are RELATIVE: the 90-day age cap is real, so a hardcoded
// calendar date silently ages out of the ledger and the suite goes green-empty.
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const action = (over = {}) => ({
  type: 'cos.task.create',
  summary: 'Queued CoS task: render the shot',
  dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
  ...over,
});

beforeEach(() => {
  rmSync(EVENTS_FILE, { force: true });
  __setUserActionRetention();
});

afterAll(cleanup);

describe('recordUserAction', () => {
  it('persists an action and reads it back newest-first', async () => {
    await recordUserAction(action({ dedupeKey: 'a', happenedAt: daysAgo(2) }));
    await recordUserAction(action({ dedupeKey: 'b', happenedAt: daysAgo(1), summary: 'second' }));

    const events = await listUserActions();
    expect(events.map((e) => e.dedupeKey)).toEqual(['b', 'a']);
    expect(events[0]).toMatchObject({ type: 'cos.task.create', actor: 'user', success: true });
  });

  it('is idempotent on (type, dedupeKey)', async () => {
    expect(await recordUserAction(action({ dedupeKey: 'same' }))).not.toBeNull();
    expect(await recordUserAction(action({ dedupeKey: 'same', summary: 'retry' }))).toBeNull();
    expect(await listUserActions()).toHaveLength(1);

    // The key is scoped to the TYPE, so the same dedupe key under a different
    // action is a different event, not a swallowed duplicate.
    await recordUserAction(action({ type: 'cos.task.delete', dedupeKey: 'same' }));
    expect(await listUserActions()).toHaveLength(2);
  });

  it('refuses an unknown type or actor, and accepts a known one', async () => {
    // Bypass probe: the same call with a vocabulary member must succeed, or this
    // guard would pass for reasons unrelated to the vocabulary check.
    await expect(recordUserAction(action({ type: 'cos.task.explode' }))).rejects.toThrow(/Unknown user action type/);
    await expect(recordUserAction(action({ actor: 'robot' }))).rejects.toThrow(/Unknown user action actor/);
    await expect(recordUserAction(action({ actor: 'schedule' }))).resolves.not.toBeNull();
  });

  it('accepts the phase-3 types (#5596)', async () => {
    for (const type of [
      'media.image.enqueue', 'media.video.enqueue', 'brain.capture',
      'instance-feature.toggle', 'cos.schedule.update',
    ]) {
      await expect(recordUserAction(action({ type, dedupeKey: type }))).resolves.not.toBeNull();
    }
  });

  it('refuses an action with no dedupe key', async () => {
    await expect(recordUserAction(action({ dedupeKey: '  ' }))).rejects.toThrow(/missing a dedupeKey/);
  });

  it('drops credential-shaped payload keys and lists their paths', async () => {
    await recordUserAction(action({
      dedupeKey: 'secretive',
      payload: {
        taskId: 'task-1',
        provider: 'claude',
        apiKey: 'sk-EXAMPLE-not-a-real-key',
        nested: { refreshToken: 'EXAMPLE-token', model: 'opus' },
      },
    }));

    const [event] = await listUserActions();
    expect(event.payload.redactedKeys).toEqual(['apiKey', 'nested.refreshToken']);
    expect(event.payload).not.toHaveProperty('apiKey');
    expect(event.payload.nested).toEqual({ model: 'opus' });
    // The non-secret siblings survive — redaction must not be a payload wipe.
    expect(event.payload).toMatchObject({ taskId: 'task-1', provider: 'claude' });
    expect(JSON.stringify(event)).not.toContain('sk-EXAMPLE-not-a-real-key');
    expect(JSON.stringify(event)).not.toContain('EXAMPLE-token');
  });

  it('truncates a long payload string and flags the containing object', async () => {
    const prompt = 'x'.repeat(PAYLOAD_STRING_MAX_CHARS + 500);
    await recordUserAction(action({ dedupeKey: 'long', payload: { taskId: 't', prompt } }));

    const [event] = await listUserActions();
    expect(event.payload.prompt.length).toBe(PAYLOAD_STRING_MAX_CHARS + 1); // + the ellipsis
    expect(event.payload.truncated).toBe(true);
  });

  it('clamps the summary to one readable line', async () => {
    const long = `start ${'word '.repeat(200)}end`;
    await recordUserAction(action({ dedupeKey: 'wordy', summary: long }));

    const [event] = await listUserActions();
    expect(event.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(event.summary.startsWith('start ')).toBe(true);
    expect(clampSummary('  a\n  b  ')).toBe('a b');
  });
});

describe('redactPayload', () => {
  it('redacts provider-specific *Key names without eating keysChanged', () => {
    const { payload, redactedKeys } = redactPayload({
      openaiKey: 'EXAMPLE-1',
      sshKey: 'EXAMPLE-2',
      deployKeys: ['EXAMPLE-3'],
      // The recorder's own bookkeeping field and a plain list of names must
      // survive — an over-broad `key` rule would swallow both.
      keysChanged: ['timezone'],
      monkeyCount: 3,
    });
    // redactPayload reports in walk order; normalizeUserAction is what sorts.
    expect([...redactedKeys].sort()).toEqual(['deployKeys', 'openaiKey', 'sshKey']);
    expect(payload).toEqual({ keysChanged: ['timezone'], monkeyCount: 3 });
  });

  it('reports paths through arrays and tolerates a non-object payload', () => {
    const { payload, redactedKeys } = redactPayload({ items: [{ password: 'p' }, { ok: 1 }] });
    expect(redactedKeys).toEqual(['items.0.password']);
    expect(payload.items).toEqual([{}, { ok: 1 }]);
    expect(redactPayload(undefined)).toEqual({ payload: {}, redactedKeys: [] });
  });
});

describe('listUserActions', () => {
  beforeEach(async () => {
    await recordUserAction(action({
      type: 'cos.task.create', dedupeKey: 'l1', actor: 'user',
      happenedAt: daysAgo(9), target: 'task-1',
    }));
    await recordUserAction(action({
      type: 'cos.schedule.trigger', dedupeKey: 'l2', actor: 'user',
      happenedAt: daysAgo(5), target: 'branch-reconcile',
    }));
    await recordUserAction(action({
      type: 'settings.update', dedupeKey: 'l3', actor: 'system',
      happenedAt: daysAgo(1), success: false,
    }));
  });

  it('filters by type, actor, target, success, and time window', async () => {
    expect((await listUserActions({ type: 'settings.update' })).map((e) => e.dedupeKey)).toEqual(['l3']);
    expect((await listUserActions({ types: ['cos.task.create', 'settings.update'] })).map((e) => e.dedupeKey))
      .toEqual(['l3', 'l1']);
    expect((await listUserActions({ actor: 'system' })).map((e) => e.dedupeKey)).toEqual(['l3']);
    expect((await listUserActions({ target: 'branch-reconcile' })).map((e) => e.dedupeKey)).toEqual(['l2']);
    expect((await listUserActions({ success: false })).map((e) => e.dedupeKey)).toEqual(['l3']);
    expect((await listUserActions({
      from: daysAgo(7), to: daysAgo(3),
    })).map((e) => e.dedupeKey)).toEqual(['l2']);
  });

  it('pages with offset and clamps the limit', async () => {
    expect((await listUserActions({ limit: 1, offset: 1 })).map((e) => e.dedupeKey)).toEqual(['l2']);
    expect(normalizeListOptions({ types: 'cos.task.create' }).types).toEqual(['cos.task.create']);
    expect(normalizeListOptions({}).limit).toBe(DEFAULT_LIST_LIMIT);
    expect(normalizeListOptions({ limit: 5000 }).limit).toBe(MAX_LIST_LIMIT);
    expect(normalizeListOptions({ limit: 0 }).limit).toBe(1);
    expect(normalizeListOptions({ limit: -3 }).limit).toBe(1);
    expect(normalizeListOptions({ offset: -3 }).offset).toBe(0);
  });
});

describe('retention', () => {
  it('drops the oldest rows past the row cap', async () => {
    __setUserActionRetention({ maxRows: 2 });
    for (const index of [0, 1, 2]) {
      await recordUserAction(action({ dedupeKey: `r${index}`, happenedAt: daysAgo(3 - index) }));
    }
    expect((await listUserActions()).map((e) => e.dedupeKey)).toEqual(['r2', 'r1']);
  });

  it('drops rows past the age cap on the next write', async () => {
    __setUserActionRetention({ maxAgeDays: 1 });
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await recordUserAction(action({ dedupeKey: 'stale', happenedAt: old }));
    await recordUserAction(action({ dedupeKey: 'fresh' }));
    expect((await listUserActions()).map((e) => e.dedupeKey)).toEqual(['fresh']);
  });
});
