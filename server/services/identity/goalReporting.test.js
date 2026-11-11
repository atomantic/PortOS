import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('goal-reporting-') }));
vi.mock('../mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
  mlReplace: async () => {},
}));
vi.mock('../genome.js', () => ({ getGenomeSummary: async () => null }));
vi.mock('../meatspaceCalendar.js', () => ({ getActivities: async () => [] }));
vi.mock('../aiProvider.js', () => ({ callProviderAISimple: vi.fn(), parseLLMJSON: JSON.parse }));
vi.mock('../userTimezone.js', () => ({
  getUserTimezone: async () => 'UTC',
  userLocalToday: async () => new Date().toISOString().slice(0, 10),
}));
vi.mock('../calendarAccounts.js', () => ({
  listAccounts: async () => [{ id: '11111111-1111-1111-1111-111111111111', subcalendars: [
    { calendarId: 'linked', enabled: true },
    { calendarId: 'other', enabled: true },
    { calendarId: 'disabled', enabled: false },
  ] }],
  getAccount: vi.fn(),
  updateSyncStatus: vi.fn(),
}));

import { PATHS } from '../../lib/fileUtils.js';
import { DEFAULT_GOALS, GOALS_FILE } from './store.js';
import { createGoal, getGoalCalendarEvents, getGoalsTree, linkCalendarToGoal, updateGoalProgress } from './goals.js';

beforeEach(async () => {
  await mkdir(PATHS.digitalTwin, { recursive: true });
  await writeFile(GOALS_FILE, JSON.stringify(DEFAULT_GOALS));
});
afterEach(() => vi.useRealTimers());
afterAll(cleanupTempDataRoots);

describe('goal reporting workflows', () => {
  it('returns linked calendar matches beyond 200 unrelated events while retaining calendar filters', async () => {
    const goal = await createGoal({ title: 'Example goal' });
    await linkCalendarToGoal(goal.id, { subcalendarId: 'linked', matchPattern: 'practice' });
    const event = (id, subcalendarId, title, startTime = '2026-01-02T12:00:00Z') => ({
      id, subcalendarId, title, startTime, endTime: startTime,
    });
    const events = [
      ...Array.from({ length: 205 }, (_, i) => event(`other-${i}`, 'other', 'Unrelated', '2026-01-01T12:00:00Z')),
      event('match', 'linked', 'Practice session'),
      event('nonmatch', 'linked', 'Other session'),
      { ...event('declined', 'linked', 'Practice'), myStatus: 'declined' },
      event('disabled', 'disabled', 'Practice'),
      event('outside', 'linked', 'Practice', '2026-02-01T12:00:00Z'),
    ];
    await mkdir(join(PATHS.calendar, 'cache'), { recursive: true });
    await writeFile(join(PATHS.calendar, 'cache', '11111111-1111-1111-1111-111111111111.json'), JSON.stringify({ events }));

    expect((await getGoalCalendarEvents(goal.id, '2026-01-01', '2026-01-31')).map(e => e.id)).toEqual(['match']);
    expect(await getGoalCalendarEvents('missing', '2026-01-01', '2026-01-31')).toEqual([]);
  });

  it.each([
    ['stable decline', [90, 80, 70, 60], 'stable'],
    ['accelerating decline', [90, 80, 60, 40], 'decreasing'],
    ['slowing decline', [90, 70, 60, 50], 'increasing'],
    ['steady gain', [10, 20, 30, 40], 'stable'],
  ])('reports %s through the goals tree', async (_label, values, trend) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const goal = await createGoal({ title: 'Example goal' });
    for (const [i, day] of ['01', '11', '21', '31'].entries()) {
      vi.setSystemTime(new Date(`2026-01-${day}T12:00:00Z`));
      await updateGoalProgress(goal.id, values[i]);
    }
    const tree = await getGoalsTree();
    expect(tree.flat[0].velocity.trend).toBe(trend);
  });
});
