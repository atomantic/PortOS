import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-epigenetic-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const {
  addIntervention,
  deleteIntervention,
  getComplianceSummary,
  getInterventions,
  logEntry,
} = await import('./epigenetic.js');

const meatspaceRoot = join(tempRoot, 'meatspace');

const dayKey = (daysAgo) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
};

const addTracked = (id, frequency = 'daily') => addIntervention({
  id,
  name: id,
  category: 'custom',
  frequency,
  trackingUnit: 'dose',
});

describe('epigenetic intervention persistence', () => {
  beforeEach(async () => {
    await rm(meatspaceRoot, { recursive: true, force: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(cleanup);

  it('persists an added intervention and removes it with all associated data', async () => {
    await addTracked('strength-training', 'weekly');
    await logEntry('strength-training', { amount: 45, date: '2026-09-10' });

    await expect(getInterventions()).resolves.toMatchObject({
      interventions: {
        'strength-training': {
          id: 'strength-training',
          frequency: 'weekly',
          logs: [{ amount: 45, date: '2026-09-10' }],
        },
      },
      trackedCount: 1,
    });

    await expect(deleteIntervention('strength-training')).resolves.toEqual({ success: true });
    await expect(getInterventions()).resolves.toMatchObject({ interventions: {}, trackedCount: 0 });
  });

  it('replaces a same-day entry and keeps the remaining logs in date order', async () => {
    await addTracked('vitamin-d');
    await logEntry('vitamin-d', { amount: 3, date: '2026-09-12', notes: 'first' });
    await logEntry('vitamin-d', { amount: 1, date: '2026-09-10' });
    await logEntry('vitamin-d', { amount: 5, date: '2026-09-12', notes: 'corrected' });

    const { interventions } = await getInterventions();
    expect(interventions['vitamin-d'].logs).toHaveLength(2);
    expect(interventions['vitamin-d'].logs.map(({ date }) => date)).toEqual([
      '2026-09-10',
      '2026-09-12',
    ]);
    expect(interventions['vitamin-d'].logs[1]).toMatchObject({ amount: 5, notes: 'corrected' });
  });

  it('uses daily and weekly schedules to calculate compliance over the same window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    await addTracked('daily-habit', 'daily');
    await addTracked('weekly-habit', 'weekly');
    await logEntry('daily-habit', { amount: 1, date: dayKey(0) });
    await logEntry('daily-habit', { amount: 1, date: dayKey(1) });
    await logEntry('daily-habit', { amount: 1, date: dayKey(8) });
    await logEntry('weekly-habit', { amount: 1, date: dayKey(2) });

    const result = await getComplianceSummary(7);

    expect(result).toMatchObject({ periodDays: 7, startDate: dayKey(7) });
    expect(result.summary['daily-habit']).toMatchObject({
      compliance: 2 / 7,
      daysCovered: 2,
      expectedDays: 7,
      recentLogCount: 2,
      lastLogged: dayKey(0),
    });
    expect(result.summary['weekly-habit']).toMatchObject({
      compliance: 1,
      daysCovered: 1,
      expectedDays: 1,
      recentLogCount: 1,
      lastLogged: dayKey(2),
    });
  });

  it('reports active, grace-period, broken, and empty streaks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    await addTracked('active');
    await addTracked('grace');
    await addTracked('broken');
    await addTracked('empty');

    for (const daysAgo of [0, 1, 2]) {
      await logEntry('active', { amount: 1, date: dayKey(daysAgo) });
    }
    for (const daysAgo of [1, 2]) {
      await logEntry('grace', { amount: 1, date: dayKey(daysAgo) });
    }
    await logEntry('broken', { amount: 1, date: dayKey(2) });

    const { summary } = await getComplianceSummary(7);
    expect(summary.active.streak).toBe(3);
    expect(summary.grace.streak).toBe(2);
    expect(summary.broken.streak).toBe(0);
    expect(summary.empty.streak).toBe(0);
  });
});
