import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { meatspace: '/mock/meatspace', data: '/mock', health: '/mock/health', digitalTwin: '/mock/digital-twin' },
  readJSONFile: vi.fn(async (_path, fallback) => structuredClone(fallback)),
  atomicWrite: vi.fn(), ensureDir: vi.fn(), readJSONFileStrict: vi.fn(),
  getDateString: () => '2026-01-01',
}));
vi.mock('./genome.js', () => ({ getSnpIndex: vi.fn() }));
vi.mock('./mortalLoomStore.js', () => ({
  mlGetProfileIfEnabled: vi.fn(), mlPatchProfileIfEnabled: vi.fn(),
  readDailyLogIfEnabled: vi.fn(), isMortalLoomEnabled: vi.fn(async () => false),
  mlArrayIfEnabled: vi.fn(async () => null),
}));
import { atomicWrite } from '../lib/fileUtils.js';
import { updateLifestyle } from './meatspace.js';
import { addActivity } from './meatspaceCalendar.js';
import { addBloodTest } from './meatspaceHealth.js';
import { writeDayFile } from './appleHealthIngest.js';
import { meatspaceEvents } from './meatspaceEvents.js';

const changed = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  atomicWrite.mockResolvedValue(undefined);
  meatspaceEvents.on('changed', changed);
});
afterEach(() => meatspaceEvents.off('changed', changed));

// These are distinct persistence boundaries; an early emit at any one would
// make the event-driven overview read the old value with no later correction.
it.each([
  ['lifestyle', () => updateLifestyle({ sleepHoursPerNight: 8 }), ['overview', 'alcohol', 'calendar']],
  ['calendar', () => addActivity({ name: 'Example Activity', cadence: 'week', frequency: 1 }), ['calendar']],
  ['local health CRUD', () => addBloodTest({ date: '2026-01-01' }), ['blood']],
  ['Apple Health import', () => writeDayFile('2026-01-01', { metrics: { body_mass: [] } }), ['healthBody']],
])('%s invalidates after persistence and never on rejected persistence', async (_name, write, resources) => {
  let persist;
  atomicWrite.mockImplementationOnce(() => new Promise(resolve => { persist = resolve; }));
  const writing = write();
  await vi.waitFor(() => expect(persist).toBeTypeOf('function'));
  expect(changed).not.toHaveBeenCalled();
  persist();
  await writing;
  expect(changed).toHaveBeenCalledExactlyOnceWith({ resources });
  changed.mockClear();
  atomicWrite.mockRejectedValueOnce(new Error('write failed'));
  await expect(write()).rejects.toThrow('write failed');
  expect(changed).not.toHaveBeenCalled();
});


it('does not refresh body metrics for unrelated Apple Health changes', async () => {
  await writeDayFile('2026-01-01', { metrics: { body_mass: [], heart_rate: [] } }, ['heart_rate']);
  expect(changed).not.toHaveBeenCalled();
});
