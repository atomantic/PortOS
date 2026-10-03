import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-epigenetic-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy({ ...actual, atomicWrite: vi.fn(actual.atomicWrite) });
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const { atomicWrite } = await import('../lib/fileUtils.js');
const { readFile: realReadFile } = await vi.importActual('fs/promises');

const {
  addIntervention,
  deleteIntervention,
  getComplianceSummary,
  getInterventions,
  logEntry,
  updateIntervention,
} = await import('./epigenetic.js');

const meatspaceRoot = join(tempRoot, 'meatspace');
const savedFile = join(meatspaceRoot, 'epigenetic.json');

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
    vi.mocked(readFile).mockReset().mockImplementation(realReadFile);
    vi.mocked(atomicWrite).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(cleanup);


  const mutations = [
    () => addTracked('example-new'),
    () => updateIntervention('example-existing', { notes: 'updated' }),
    () => logEntry('example-existing', { amount: 1, date: '2026-09-10' }),
    () => deleteIntervention('example-existing'),
  ];

  const expectProtected = async (bytes) => {
    vi.mocked(atomicWrite).mockClear();
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
      expect(await realReadFile(savedFile, 'utf8')).toBe(bytes);
    }
    expect(atomicWrite).not.toHaveBeenCalled();
  };

  it.each(['EACCES', 'EIO'])('preserves saved history when reading fails with %s and recovers on retry', async (code) => {
    await addTracked('example-existing');
    await logEntry('example-existing', { amount: 2, date: '2026-09-09' });
    const bytes = await realReadFile(savedFile, 'utf8');
    vi.mocked(readFile).mockImplementation((path, ...args) =>
      path === savedFile
        ? Promise.reject(Object.assign(new Error('synthetic read failure'), { code }))
        : realReadFile(path, ...args));

    await expectProtected(bytes);

    vi.mocked(readFile).mockImplementation(realReadFile);
    await addTracked('example-new');
    const { interventions } = await getInterventions();
    expect(Object.keys(interventions)).toEqual(['example-existing', 'example-new']);
    expect(interventions['example-existing'].logs).toMatchObject([{ amount: 2 }]);
  });

  it.each([
    ['truncated', '{"interventions":'],
    ['malformed', 'invalid JSON'],
    ['empty', ''],
    ['whitespace', '  '],
    ['null root', 'null'],
    ['array root', '[]'],
    ['scalar root', '42'],
    ['missing interventions', '{}'],
    ['null interventions', '{"interventions":null}'],
    ['array interventions', '{"interventions":[]}'],
    ['scalar interventions', '{"interventions":1}'],
    ['null intervention', '{"interventions":{"example-existing":null}}'],
    ['array intervention', '{"interventions":{"example-existing":[]}}'],
    ['missing logs', '{"interventions":{"example-existing":{}}}'],
    ['null logs', '{"interventions":{"example-existing":{"logs":null}}}'],
    ['object logs', '{"interventions":{"example-existing":{"logs":{}}}}'],
  ])('preserves %s input across every mutation and resumes after repair', async (_name, bytes) => {
    await addTracked('example-existing');
    const healthy = await realReadFile(savedFile, 'utf8');
    await writeFile(savedFile, bytes);
    await expectProtected(bytes);

    await writeFile(savedFile, healthy);
    await updateIntervention('example-existing', { notes: 'repaired' });
    const { interventions } = await getInterventions();
    expect(interventions['example-existing'].notes).toBe('repaired');
  });

  it('initializes absent stores with independent nested defaults', async () => {
    const first = await getInterventions();
    first.interventions['example-local'] = { logs: [] };
    await expect(getInterventions()).resolves.toMatchObject({ interventions: {}, lastUpdated: null });
    await addTracked('example-first');
    await rm(savedFile);
    await addTracked('example-second');
    const { interventions } = await getInterventions();
    expect(Object.keys(interventions)).toEqual(['example-second']);
  });

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
