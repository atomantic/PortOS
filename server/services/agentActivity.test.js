import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-agent-activity-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const { cleanupOldActivity, getActivityTimeline } = await import('./agentActivity.js');

const activityRoot = join(tempRoot, 'agents', 'activity');

const writeDay = async (agentId, date, activities) => {
  const directory = join(activityRoot, agentId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${date}.json`), JSON.stringify({ activities }));
};

const entry = (id, timestamp) => ({ id, action: 'example', status: 'completed', timestamp });

describe('getActivityTimeline', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
  });

  afterAll(cleanup);

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
