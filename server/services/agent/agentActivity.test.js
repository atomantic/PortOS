import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-agent-activity-' });

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makeProxy(actual);
});

const { getAgentStats, getActivityTimeline, getTodayActionCount, logActivity } = await import('./agentActivity.js');

const activityRoot = join(tempRoot, 'agents', 'activity');

const writeDay = async (agentId, date, activities) => {
  const directory = join(activityRoot, agentId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${date}.json`), JSON.stringify({ activities }));
};

const entry = (id, timestamp) => ({ id, action: 'example', status: 'completed', timestamp });

// Module-scope, not nested in a describe: `cleanup()` removes `tempRoot` itself,
// so it must run after every describe block in the file (#9032).
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

describe('getAgentStats totals', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
  });

  it('counts posts, comments and votes from completed records only', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rec = (action, status, result) => ({ id: `${action}-${status}`, action, status, result, timestamp: `${today}T00:00:00.000Z` });
    await writeDay('agent-s', today, [
      rec('post', 'started'),
      rec('post', 'completed', {}),
      rec('post', 'failed'),
      rec('comment', 'completed', { action: 'commented' }),
      rec('comment', 'completed', { action: 'none' }),
      rec('comment', 'skipped'),
      rec('vote', 'completed', {}),
      rec('vote', 'completed', { action: 'none' }),
      rec('engage', 'completed', { votes: [1, 2], comments: [1] }),
      rec('engage', 'completed', {}),
      rec('monitor', 'completed', { upvoted: [1], replied: [1, 2, 3] })
    ]);
    const stats = await getAgentStats('agent-s', 1);
    expect(stats).toMatchObject({ totalPosts: 1, totalComments: 5, totalVotes: 4, totalActivities: 11 });
    expect(stats.byAction.post).toBe(3);
    expect(stats.byStatus.completed).toBe(8);
  });
});
