import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-agent-activity-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const { cleanupOldActivity, getActivityTimeline, getTodayActionCount, logActivity } = await import('./agentActivity.js');

const activityRoot = join(tempRoot, 'agents', 'activity');

const writeDay = async (agentId, date, activities) => {
  const directory = join(activityRoot, agentId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${date}.json`), JSON.stringify({ activities }));
};

const entry = (id, timestamp) => ({ id, action: 'example', status: 'completed', timestamp });

// Module-scope, not nested in the first describe below: `cleanup()` removes
// `tempRoot` itself, and a SECOND describe block (`cleanupOldActivity`)
// recreates directories under it after that first block's own afterAll
// would have already fired and removed it — so the root never got a final
// cleanup that ran after every test in the file (#9032).
afterAll(cleanup);

describe('getActivityTimeline', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
  });

  it('continues across midnight into older day files', async () => {
    await writeDay('agent-a', '2026-08-23', [entry('new', '2026-08-23T00:01:00.000Z')]);
    await writeDay('agent-a', '2026-08-22', [entry('old', '2026-08-22T23:59:00.000Z')]);

    await expect(getActivityTimeline({ limit: 2 })).resolves.toMatchObject([
      { id: 'new', agentId: 'agent-a' },
      { id: 'old', agentId: 'agent-a' },
    ]);
  });

  it('pages beyond three times the page limit without repeating the shallow window', async () => {
    await writeDay('agent-a', '2026-08-23', Array.from({ length: 10 }, (_, index) => (
      entry(`item-${index}`, `2026-08-23T00:00:${String(10 - index).padStart(2, '0')}.000Z`)
    )));

    await expect(getActivityTimeline({
      limit: 2,
      beforeTimestamp: '2026-08-23T00:00:05.000Z',
    })).resolves.toMatchObject([{ id: 'item-6' }, { id: 'item-7' }]);
  });

  it('returns a stable newest-first order across agents', async () => {
    await writeDay('agent-b', '2026-08-23', [
      entry('b-later', '2026-08-23T12:00:01.000Z'),
      entry('b-tie', '2026-08-23T12:00:00.000Z'),
    ]);
    await writeDay('agent-a', '2026-08-23', [entry('a-tie', '2026-08-23T12:00:00.000Z')]);

    const first = await getActivityTimeline({ limit: 3 });
    const second = await getActivityTimeline({ limit: 3 });

    expect(first.map(({ id }) => id)).toEqual(['b-later', 'a-tie', 'b-tie']);
    expect(second).toEqual(first);
  });

  it('filters by action before the limit cut and still honors the cursor', async () => {
    const mixed = (id, ts, action) => ({ ...entry(id, ts), action });
    await writeDay('agent-a', '2026-08-23', [
      mixed('say-1', '2026-08-23T00:00:09.000Z', 'mw_say'),
      mixed('post-1', '2026-08-23T00:00:08.000Z', 'post'),
      mixed('think-1', '2026-08-23T00:00:07.000Z', 'mw_think'),
    ]);
    await writeDay('agent-a', '2026-08-22', [
      mixed('say-2', '2026-08-22T00:00:09.000Z', 'mw_say'),
      mixed('post-2', '2026-08-22T00:00:08.000Z', 'post'),
    ]);

    const ids = async (options) => (await getActivityTimeline(options)).map(({ id }) => id);
    await expect(ids({ limit: 2, actions: ['post'] })).resolves.toEqual(['post-1', 'post-2']);
    await expect(ids({ limit: 3, actions: ['mw_say', 'mw_think'] })).resolves.toEqual(['say-1', 'think-1', 'say-2']);
    await expect(ids({
      limit: 5, actions: ['mw_say'], beforeTimestamp: '2026-08-23T00:00:09.000Z',
    })).resolves.toEqual(['say-2']);
  });

  it('skips empty days while walking backward', async () => {
    await writeDay('agent-a', '2026-08-23', []);
    await writeDay('agent-a', '2026-08-21', [entry('older', '2026-08-21T09:00:00.000Z')]);

    await expect(getActivityTimeline({ limit: 1 })).resolves.toMatchObject([
      { id: 'older', agentId: 'agent-a' },
    ]);
  });
});

// A destructive-action guard: `cleanupOldActivity` unlinks day files, and the
// service is called from schedulers as well as the HTTP route, so the floor
// cannot live only at the request boundary (#5714).
describe('cleanupOldActivity', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Day files are named with the LOCAL date, so the fixtures are keyed the
  // same way — spelled out here rather than imported, so the test does not
  // re-implement the helper it is checking.
  const dayKey = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const seedTodayAndOld = async () => {
    await writeDay('agent-a', dayKey(0), [entry('today', '2026-01-01T00:00:00.000Z')]);
    await writeDay('agent-a', dayKey(400), [entry('ancient', '2025-01-01T00:00:00.000Z')]);
    return { today: dayKey(0), old: dayKey(400) };
  };

  const dayFiles = async () => (await readdir(join(activityRoot, 'agent-a'))).sort();

  it.each([0, -5, 1.5, 'abc', null])('falls back to 30 days for %s', async (bad) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { today } = await seedTodayAndOld();

    await expect(cleanupOldActivity(bad)).resolves.toBe(1);
    // The ancient file goes; today's survives — the whole archive does not.
    await expect(dayFiles()).resolves.toEqual([`${today}.json`]);
  });

  it('compares the file name against the local cutoff date, not a parsed UTC instant', async () => {
    await writeDay('agent-a', dayKey(7), [entry('boundary', '2026-01-01T00:00:00.000Z')]);
    await writeDay('agent-a', dayKey(8), [entry('past-boundary', '2026-01-01T00:00:00.000Z')]);

    // The day exactly `daysToKeep` back is still inside the window; only the
    // day before it expires. Parsing the name as a Date made the boundary day
    // lose to the current time-of-day and get deleted a day early.
    await expect(cleanupOldActivity(7)).resolves.toBe(1);
    await expect(dayFiles()).resolves.toEqual([`${dayKey(7)}.json`]);
  });

  it('never unlinks a non-day file', async () => {
    await mkdir(join(activityRoot, 'agent-a'), { recursive: true });
    await writeFile(join(activityRoot, 'agent-a', 'notes.json'), '{}');

    await expect(cleanupOldActivity(1)).resolves.toBe(0);
    await expect(dayFiles()).resolves.toEqual(['notes.json']);
  });

  it('honours a real retention window', async () => {
    const { today, old } = await seedTodayAndOld();

    await expect(cleanupOldActivity(3650)).resolves.toBe(0);
    await expect(dayFiles()).resolves.toEqual([`${old}.json`, `${today}.json`].sort());
  });
});

describe('logActivity concurrency', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
  });

  // Fire-and-forget bursts (WebSocket frames) must not lose entries to a
  // load → push → save race on the same agent/day file.
  it('persists every entry from an unawaited burst for one agent and day', async () => {
    const accountId = 'burst-account';
    const timestamp = new Date().toISOString();
    const writes = Array.from({ length: 20 }, (_, index) => logActivity({
      agentId: 'agent-burst',
      accountId,
      action: 'burst-action',
      status: 'completed',
      params: { index },
      timestamp,
    }));
    await Promise.all(writes);

    const dayFile = (await readdir(join(activityRoot, 'agent-burst')))[0];
    const { activities } = JSON.parse(await readFile(join(activityRoot, 'agent-burst', dayFile), 'utf-8'));
    expect(activities).toHaveLength(20);
    expect(new Set(activities.map(a => a.params.index)).size).toBe(20);
    await expect(getTodayActionCount(accountId, 'burst-action')).resolves.toBe(20);
  });
});
