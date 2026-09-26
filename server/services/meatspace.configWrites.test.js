import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  config: null,
  goals: null
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: {
    data: '/tmp/portos-test-data',
    meatspace: '/tmp/portos-test-data/meatspace',
    digitalTwin: '/tmp/portos-test-data/digital-twin'
  },
  atomicWrite: vi.fn(async (_path, value) => { store.config = structuredClone(value); }),
  ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(async (path, fallback) => {
    const value = path.endsWith('goals.json') ? store.goals : store.config;
    return value === null ? structuredClone(fallback) : structuredClone(value);
  }),
  readJSONFileStrict: vi.fn(async () => ({ ok: true, value: store.config }))
}));
vi.mock('./genome.js', () => ({ getSnpIndex: vi.fn(async () => new Map([['Y', { chromosome: 'Y' }]])) }));
vi.mock('./meatspaceDailyLog.js', () => ({ readLocalDailyLog: vi.fn(async () => null) }));
vi.mock('./mortalLoomStore.js', () => ({
  mlGetProfileIfEnabled: vi.fn(async () => null),
  mlPatchProfileIfEnabled: vi.fn(async () => {})
}));
vi.mock('fs/promises', () => ({ readFile: vi.fn(async () => '{}') }));

const meatspace = await import('./meatspace.js');
const { meatspaceEvents } = await import('./meatspaceEvents.js');

const initialConfig = () => ({
  birthDate: null,
  sex: null,
  sexSource: null,
  lifestyle: {
    smokingStatus: 'never',
    exerciseMinutesPerWeek: 150,
    sleepHoursPerNight: 7.5,
    dietQuality: 'good',
    stressLevel: 'moderate',
    bmi: null,
    chronicConditions: []
  },
  updatedAt: null
});

describe('meatspace config write serialization (#4913)', () => {
  beforeEach(() => {
    store.config = initialConfig();
    store.goals = null;
  });

  it('invalidates the death clock only after its changed inputs persist', async () => {
    const snapshots = [];
    const listener = payload => snapshots.push({ payload, config: structuredClone(store.config) });
    meatspaceEvents.on('death-clock:changed', listener);
    await meatspace.updateBirthDate('1980-01-01', { syncGoals: false });
    await meatspace.updateLifestyle({ sleepHoursPerNight: 8 });
    meatspaceEvents.off('death-clock:changed', listener);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ payload: {}, config: { birthDate: '1980-01-01' } });
    expect(snapshots[1].config.lifestyle.sleepHoursPerNight).toBe(8);
  });

  it('retains simultaneous config and lifestyle patches', async () => {
    await Promise.all([
      meatspace.updateConfig({ sex: 'female', sexSource: 'manual' }),
      meatspace.updateLifestyle({ sleepHoursPerNight: 8 })
    ]);

    expect(store.config).toMatchObject({
      sex: 'female',
      sexSource: 'manual',
      lifestyle: { sleepHoursPerNight: 8 }
    });
  });

  it('preserves a migrated birth date until a queued update supersedes it', async () => {
    store.goals = { birthDate: '1970-01-01' };
    expect(await meatspace.getBirthDate()).toEqual({ birthDate: '1970-01-01' });

    await Promise.all([
      meatspace.getConfig(),
      meatspace.updateBirthDate('1980-01-01', { syncGoals: false })
    ]);

    expect(store.config).toMatchObject({
      sex: 'female',
      sexSource: 'genome',
      birthDate: '1980-01-01'
    });
  });
});
