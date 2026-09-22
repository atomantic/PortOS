import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// The alcohol, nicotine, and body-composition services all read the same
// daily-log.json. They used to each carry a byte-identical copy of the probe →
// read → validate sequence; #4112 collapsed that into meatspaceDailyLog.js. These
// tests pin the shared reader's behavior AND the delegation from the callers, so
// the strict/#2726 semantics can't drift back apart.

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  getDateString: vi.fn(() => '2024-06-01'),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    meatspace: '/mock/data/meatspace'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(),
  mlPatchById: vi.fn(),
  mlRemoveById: vi.fn(),
  mlIdAtDateIndex: vi.fn(),
  mlUpsertHealthMetricByDate: vi.fn()
}));

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { readDailyLogIfEnabled } from './mortalLoomStore.js';
import { DAILY_LOG_FILE, readLocalDailyLog, loadMeatspaceDailyLog } from './meatspaceDailyLog.js';
import { getAlcoholSummary, getDailyAlcohol, logDrink, updateDrink } from './meatspaceAlcohol.js';
import { getDailyNicotine, getNicotineSummary, logNicotine } from './meatspaceNicotine.js';
import { addBodyEntry, getBodyHistory } from './meatspaceHealth.js';

// Built with join() rather than a literal: the module builds it the same way, and
// win32 separators would make a hardcoded POSIX path fail on the Windows runner.
const EXPECTED_LOG_PATH = join('/mock/data/meatspace', 'daily-log.json');

beforeEach(() => {
  vi.clearAllMocks();
  readDailyLogIfEnabled.mockResolvedValue(null);
});

describe('DAILY_LOG_FILE', () => {
  it('points at daily-log.json under the meatspace data dir', () => {
    expect(DAILY_LOG_FILE).toBe(EXPECTED_LOG_PATH);
  });
});

describe('readLocalDailyLog', () => {
  it('reads the local mirror without consulting MortalLoom', async () => {
    readJSONFile.mockResolvedValue({ entries: [{ date: '2024-03-02' }], lastEntryDate: '2024-03-02' });
    const log = await readLocalDailyLog();
    expect(log.entries).toEqual([{ date: '2024-03-02' }]);
    expect(readDailyLogIfEnabled).not.toHaveBeenCalled();
  });

  it('passes the file, default, and allowArray:false through to readJSONFile', async () => {
    readJSONFile.mockResolvedValue({ entries: [] });
    await readLocalDailyLog({ strict: true, label: 'Alcohol' });
    expect(readJSONFile).toHaveBeenCalledWith(
      EXPECTED_LOG_PATH,
      { entries: [], lastEntryDate: null },
      { allowArray: false, strict: true }
    );
  });

  it('returns the empty log when the file is absent', async () => {
    readJSONFile.mockResolvedValue({ entries: [], lastEntryDate: null });
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: null });
  });

  it('hands back a fresh empty log each time so callers can mutate it', async () => {
    readJSONFile.mockResolvedValue(null);
    const first = await readLocalDailyLog();
    first.entries.push({ date: '2024-01-01' });
    const second = await readLocalDailyLog();
    expect(second.entries).toEqual([]);
  });

  it('coerces a missing entries array to empty when not strict', async () => {
    readJSONFile.mockResolvedValue({ lastEntryDate: '2024-01-01' });
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: '2024-01-01' });
  });

  it('substitutes the empty log for a non-object root when not strict', async () => {
    readJSONFile.mockResolvedValue([{ date: '2024-01-01' }]);
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: null });
  });

  it('throws with the domain label for a non-object root under strict', async () => {
    readJSONFile.mockResolvedValue([{ date: '2024-01-01' }]);
    await expect(readLocalDailyLog({ strict: true, label: 'Health' }))
      .rejects.toThrow(/Health daily log malformed/);
  });

  it('throws with the domain label for a non-array entries under strict', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(readLocalDailyLog({ strict: true, label: 'Nicotine' }))
      .rejects.toThrow(/Nicotine daily log malformed/);
  });

  it('does not swallow a strict read failure raised by readJSONFile', async () => {
    readJSONFile.mockRejectedValue(new Error('Unreadable JSON file: /mock/data/meatspace/daily-log.json'));
    await expect(readLocalDailyLog({ strict: true })).rejects.toThrow(/Unreadable JSON file/);
  });
});

describe('loadMeatspaceDailyLog', () => {
  it('prefers the MortalLoom-composed log and skips the local read', async () => {
    readDailyLogIfEnabled.mockResolvedValue({ entries: [{ date: '2024-05-05' }], lastEntryDate: '2024-05-05' });
    readJSONFile.mockResolvedValue({ entries: [{ date: '1999-01-01' }] });
    const log = await loadMeatspaceDailyLog();
    expect(log.entries).toEqual([{ date: '2024-05-05' }]);
    expect(readJSONFile).not.toHaveBeenCalled();
  });

  it('falls back to the local mirror when MortalLoom is off', async () => {
    readDailyLogIfEnabled.mockResolvedValue(null);
    readJSONFile.mockResolvedValue({ entries: [{ date: '2024-04-04' }], lastEntryDate: '2024-04-04' });
    const log = await loadMeatspaceDailyLog();
    expect(log.entries).toEqual([{ date: '2024-04-04' }]);
  });

  it('forwards strict to the MortalLoom probe', async () => {
    readJSONFile.mockResolvedValue({ entries: [] });
    await loadMeatspaceDailyLog({ strict: true });
    expect(readDailyLogIfEnabled).toHaveBeenCalledWith({ strict: true });
  });

  it('propagates a strict MortalLoom failure instead of scoring a local empty', async () => {
    readDailyLogIfEnabled.mockRejectedValue(new Error('MortalLoom store unreadable for daily log'));
    readJSONFile.mockResolvedValue({ entries: [] });
    await expect(loadMeatspaceDailyLog({ strict: true })).rejects.toThrow(/unreadable/i);
    expect(readJSONFile).not.toHaveBeenCalled();
  });
});

// The point of the extraction is that the three services actually go through it.
// Each case asserts on a distinctive value or label that only the shared reader
// (driven by the mocked readJSONFile) can produce, so a mock that stopped
// intercepting would fail rather than pass against a default.
describe('caller delegation (#4112)', () => {
  it('routes alcohol reads through the shared reader', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-02', alcohol: { drinks: [{ name: 'Example Lager', oz: 12, abv: 5 }] } }]
    });
    const entries = await getDailyAlcohol();
    expect(entries).toEqual([
      { date: '2024-02-02', alcohol: { drinks: [{ name: 'Example Lager', oz: 12, abv: 5 }] } }
    ]);
    expect(readDailyLogIfEnabled).toHaveBeenCalled();
  });

  it('labels an alcohol strict failure as Alcohol', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getDailyAlcohol(null, null, { strict: true }))
      .rejects.toThrow(/Alcohol daily log malformed/);
  });

  it('routes nicotine reads through the shared reader', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-03', nicotine: { items: [{ product: 'Example Pouch', mgPerUnit: 3, count: 2 }], totalMg: 6 } }]
    });
    const entries = await getDailyNicotine();
    expect(entries).toHaveLength(1);
    expect(entries[0].nicotine.totalMg).toBe(6);
    expect(readDailyLogIfEnabled).toHaveBeenCalled();
  });

  it('labels a nicotine strict failure as Nicotine', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getDailyNicotine(null, null, { strict: true }))
      .rejects.toThrow(/Nicotine daily log malformed/);
  });

  it('routes body history through the local reader, not the composed log', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-04', body: { weightLbs: 175 } }]
    });
    expect(await getBodyHistory()).toEqual([{ date: '2024-02-04', weightLbs: 175 }]);
    // Body entries come from MortalLoom's own `bodyEntries` key, so the composed
    // daily-log probe must stay out of this path (see meatspaceHealth.js).
    expect(readDailyLogIfEnabled).not.toHaveBeenCalled();
  });

  it('labels a body-history strict failure as Health', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getBodyHistory({ strict: true })).rejects.toThrow(/Health daily log malformed/);
  });
});

// Concurrent alcohol, nicotine, and body writers share one file. The queue has to
// hold the whole read-modify-write, and a miss or a bad read must not replace it.
describe('serialized daily-log writes (#8032)', () => {
  beforeEach(() => {
    readJSONFile.mockReset();
    atomicWrite.mockReset();
    atomicWrite.mockResolvedValue(undefined);
  });

  function useLogStore(initial) {
    let store = structuredClone(initial);
    readJSONFile.mockImplementation(async () => structuredClone(store));
    atomicWrite.mockImplementation(async (file, data) => {
      if (String(file).endsWith('daily-log.json')) store = structuredClone(data);
    });
    return () => store;
  }

  it('keeps alcohol, nicotine, and body fields when the three writers overlap', async () => {
    let store = {
      entries: [{
        date: '2024-01-01',
        alcohol: { drinks: [{ name: 'Kept', oz: 12, abv: 5, count: 1 }], standardDrinks: 1 }
      }],
      lastEntryDate: '2024-01-01'
    };
    let activeReads = 0;
    let maxActiveReads = 0;
    readJSONFile.mockImplementation(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = structuredClone(store);
      activeReads -= 1;
      return snapshot;
    });
    atomicWrite.mockImplementation(async (file, data) => {
      if (String(file).endsWith('daily-log.json')) store = structuredClone(data);
    });

    await Promise.all([
      logDrink({ name: 'Example Lager', oz: 12, abv: 5, count: 1, date: '2024-06-01' }),
      logNicotine({ product: 'Example Pouch', mgPerUnit: 3, count: 2, date: '2024-06-01' }),
      addBodyEntry({ date: '2024-06-01', weightLbs: 175 })
    ]);

    expect(maxActiveReads).toBe(1);
    const kept = store.entries.find((entry) => entry.date === '2024-01-01');
    const day = store.entries.find((entry) => entry.date === '2024-06-01');
    expect(kept.alcohol.drinks[0].name).toBe('Kept');
    expect(day.alcohol.drinks).toEqual([
      expect.objectContaining({ name: 'Example Lager', oz: 12, abv: 5, count: 1 })
    ]);
    expect(day.nicotine).toMatchObject({
      items: [expect.objectContaining({ product: 'Example Pouch', mgPerUnit: 3, count: 2 })],
      totalMg: 6
    });
    expect(day.body).toEqual({ weightLbs: 175 });
    expect(store.lastEntryDate).toBe('2024-06-01');
  });

  it('does not rewrite the log when the drink index is missing', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{
        date: '2024-06-01',
        alcohol: { drinks: [{ name: 'Example Lager', oz: 12, abv: 5, count: 1 }], standardDrinks: 1 }
      }],
      lastEntryDate: '2024-06-01'
    });
    await expect(updateDrink('2024-06-01', 3, { oz: 20 })).resolves.toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('does not write a body entry when the daily log is unreadable', async () => {
    readJSONFile.mockRejectedValue(new Error('Unreadable JSON file: /mock/data/meatspace/daily-log.json'));
    await expect(addBodyEntry({ date: '2024-06-01', weightLbs: 175 })).rejects.toThrow(/Unreadable JSON file/);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('labels a body-write failure as Health and does not replace the log', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(addBodyEntry({ date: '2024-06-01', weightLbs: 175 }))
      .rejects.toThrow(/Health daily log malformed/);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('drops the alcohol summary cache after a local write', async () => {
    const current = useLogStore({ entries: [], lastEntryDate: null });
    await logDrink({ name: 'Example Lager', oz: 12, abv: 5, count: 1, date: '2024-06-01' });
    expect((await getAlcoholSummary()).today).toBe(1);
    await logDrink({ name: 'Example Wine', oz: 5, abv: 12, count: 1, date: '2024-06-01' });
    expect((await getAlcoholSummary()).today).toBe(2);
    expect(current().entries.find((entry) => entry.date === '2024-06-01').alcohol.drinks).toHaveLength(2);
  });

  it('drops the nicotine summary cache after a local write', async () => {
    useLogStore({ entries: [], lastEntryDate: null });
    await logNicotine({ product: 'Example Pouch', mgPerUnit: 3, count: 1, date: '2024-06-01' });
    expect((await getNicotineSummary()).today).toBe(3);
    await logNicotine({ product: 'Example Pouch', mgPerUnit: 4, count: 1, date: '2024-06-01' });
    expect((await getNicotineSummary()).today).toBe(7);
  });
});
