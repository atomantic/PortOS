import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('goal-reporting-') }));
vi.mock('../mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
  mlApplyGoalChanges: async () => {},
}));
vi.mock('../genome.js', () => ({ getGenomeSummary: async () => null }));
vi.mock('../meatspace/meatspaceCalendar.js', () => ({ getActivities: async () => [] }));
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
import { createGoal, getGoalsTree, updateGoalProgress } from './goals.js';

beforeEach(async () => {
  await mkdir(PATHS.digitalTwin, { recursive: true });
  await writeFile(GOALS_FILE, JSON.stringify(DEFAULT_GOALS));
});
afterEach(() => vi.useRealTimers());
afterAll(cleanupTempDataRoots);

describe('goal reporting workflows', () => {

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
